-- TripNavigate CRM - B1.1c: department work forms, expense records and the
-- Visa & Passport desk (DEC-28).
--
-- Contract: docs/implementation/frontend-first-plan-2026-10-10/b1.1/
--   b1.1-contract-2026-10-11.md section 4; plan section 3g.
-- Shapes:  b1.1-freeze-note.md (sections 3.1 and 3.2) and appendix A section 3;
--   the Accounts side of expense records follows appendix B section 7 (names
--   expense_record_accept / expense_record_return / accounts_expense_records).
--
-- What changes:
--   * workflow_settings.visa_passport_tasks_enabled becomes settable through
--     admin_set_workflow_setting. Switching it on creates, once, a task
--     'item:<id>:visa|passport' (department visa) for every accepted visa or
--     passport item that has none (removed and lost Deals skipped). Switching
--     it off creates and deletes nothing; existing desk tasks keep working.
--   * Visa department tasks finish as 'completed' (never supplier_confirmed):
--     when every applicant is issued and has the documents back, or refused /
--     withdrawn and the customer was told. A fee receipt or a reference never
--     completes anything; an issued or refused outcome needs a stored
--     authority document.
--   * public.visa_applications (one per applicant, created when the task is
--     taken), public.department_evidence (private bucket department-evidence:
--     applicant documents, fee receipts, authority outcomes, direct-payment
--     proof), public.department_cost_entries (the shared cost block; a
--     company-paid entry is an expense record for Accounts review:
--     draft -> submitted -> accepted | returned, reviewer never the submitter).
--     All three: no Data API read; definer functions only.
--   * Reads: visa_task_list / visa_task_get, department_work_form,
--     accounts_expense_records; my_work_counts adds visaTasksWaiting,
--     claimsToProcess and expensesToReview; progress counts completed visa
--     work; booking_health counts visa and passport tasks.
--   * Commands: visa_task_claim, visa_application_update,
--     visa_application_set_state, department_evidence_begin / finish / remove /
--     authorize_download, department_cost_save, department_cost_submit,
--     expense_record_accept, expense_record_return.
--   * Never: a supplier payment, an approval, a journal entry, a payable, a
--     selling price, a plan, a claim, a contact or billing data in any desk read.
--
-- Refusal tokens added (message is exactly the token):
--   55000 documents_not_checked, outcome_document_required, outcome_required,
--         application_closed, task_closed, cost_locked, receipt_required
--   22023 direct_payment_over_limit
--   Existing tokens keep their SQLSTATEs (wrong_state, not_self_approval, ...).
--
-- Rollback (forward-only): switch visa_passport_tasks_enabled off; a NEW
-- migration revokes execute on the desk and cost commands. Rows are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Task status 'completed' (visa department only)
-- ===========================================================================

alter table public.fulfilment_tasks drop constraint fulfilment_tasks_status_check;
alter table public.fulfilment_tasks
  add column completed_by uuid references public.staff_profiles (user_id),
  add column completed_at timestamptz,
  add constraint fulfilment_tasks_status_check
    check (status in ('not_started', 'in_progress', 'supplier_confirmed', 'completed')),
  add constraint fulfilment_tasks_completed_visa_only check (status <> 'completed' or department = 'visa'),
  add constraint fulfilment_tasks_supplier_not_visa check (status <> 'supplier_confirmed' or department <> 'visa'),
  add constraint fulfilment_tasks_completion_complete
    check ((status = 'completed') = (completed_at is not null and completed_by is not null));
create index fulfilment_tasks_completed_by_idx on public.fulfilment_tasks (completed_by) where completed_by is not null;
grant select (completed_by, completed_at) on public.fulfilment_tasks to authenticated;

-- Replaces 20261005000200: completed is final.
create or replace function authz.fulfilment_tasks_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_transition text := coalesce(current_setting('authz.task_transition', true), '');
begin
  if old.status = 'supplier_confirmed' then
    raise exception 'supplier-confirmed tasks are immutable' using errcode = '42501';
  end if;
  -- B1.1c: completed visa work is final; only in_progress -> completed.
  if old.status = 'completed' then
    raise exception 'completed tasks are immutable' using errcode = '42501';
  end if;
  if new.status = 'completed' and (old.status <> 'in_progress' or new.assignee_user_id is distinct from old.assignee_user_id) then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'not_started' and new.status = 'supplier_confirmed' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'not_started' and v_transition <> 'release' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  -- Review L1: the assignee may change only by reassignment (in_progress -> in_progress);
  -- never together with supplier confirmation.
  if old.status = 'in_progress' and new.status = 'supplier_confirmed'
     and new.assignee_user_id is distinct from old.assignee_user_id then
    raise exception 'fulfilment task assignee cannot change at supplier confirmation' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'in_progress'
     and new.assignee_user_id is distinct from old.assignee_user_id and v_transition <> 'reassign' then
    raise exception 'fulfilment task assignee changes only through reassignment' using errcode = '42501';
  end if;
  return new;
end;
$$;

alter table public.outbox_events drop constraint outbox_events_event_type_check;
alter table public.outbox_events add constraint outbox_events_event_type_check
  check (event_type in ('booking.version_confirmed', 'fulfilment.task_created', 'fulfilment.supplier_confirmed',
                        'booking.version_revised', 'fulfilment.task_completed'));

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

create table public.department_evidence (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  application_id uuid,
  legal_entity_id uuid not null,
  kind text not null check (kind in ('applicant_document', 'fee_receipt', 'authority_outcome', 'direct_payment_proof', 'other')),
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stored_at timestamptz,
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  check (object_path = legal_entity_id::text || '/' || task_id::text || '/' || id::text),
  check (status <> 'stored' or stored_at is not null)
);
create index department_evidence_task_idx on public.department_evidence (task_id, status);
create index department_evidence_application_idx on public.department_evidence (application_id) where application_id is not null;
create index department_evidence_uploaded_by_idx on public.department_evidence (uploaded_by);
comment on table public.department_evidence is
  'Private files of a department task (applicant documents, fee receipts, authority outcomes, direct-payment proof). Desk and branch Manager only; Accounts sees receipts and payment proof of an expense record it reviews. No Data API read.';

create table public.visa_applications (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  service_item_id uuid not null,
  deal_id uuid not null,
  legal_entity_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  state text not null default 'docs_pending'
    check (state in ('docs_pending', 'submitted', 'decision_pending', 'issued', 'refused', 'withdrawn')),
  documents jsonb not null default '{}'::jsonb check (jsonb_typeof(documents) = 'object'),
  reference text check (length(reference) between 1 and 120),
  appointment_at timestamptz,
  appointment_place text check (length(appointment_place) between 1 and 200),
  submitted_at timestamptz,
  outcome_evidence_id uuid references public.department_evidence (id),
  outcome_at timestamptz,
  customer_informed_at timestamptz,
  documents_returned_at timestamptz,
  documents_returned_by uuid references public.staff_profiles (user_id),
  row_version integer not null default 1 check (row_version >= 1),
  updated_by uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  unique (task_id, traveller_seq),
  check ((state in ('issued', 'refused')) = (outcome_evidence_id is not null and outcome_at is not null)),
  check (documents_returned_at is null or state = 'issued' or state = 'refused'),
  check ((documents_returned_at is null) = (documents_returned_by is null)),
  check (state <> 'submitted' or submitted_at is not null)
);
create index visa_applications_item_idx on public.visa_applications (service_item_id);
create index visa_applications_deal_idx on public.visa_applications (deal_id);
create index visa_applications_outcome_evidence_idx on public.visa_applications (outcome_evidence_id) where outcome_evidence_id is not null;
create index visa_applications_returned_by_idx on public.visa_applications (documents_returned_by) where documents_returned_by is not null;
create index visa_applications_updated_by_idx on public.visa_applications (updated_by) where updated_by is not null;
alter table public.department_evidence
  add constraint department_evidence_application_fk foreign key (application_id) references public.visa_applications (id);
comment on table public.visa_applications is
  'One applicant of a visa or passport task: document checklist, reference, appointment, authority outcome (with its document), customer informed, documents returned. No Data API read.';

create table public.department_cost_entries (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  deal_id uuid not null,
  legal_entity_id uuid not null,
  branch_id uuid not null,
  department text not null check (department in ('purchase', 'flight', 'visa')),
  cost_kind text not null check (cost_kind in ('government_fee', 'service_fee', 'fare', 'other')),
  amount_paise bigint not null check (amount_paise > 0),
  currency char(3) not null default 'INR' check (currency = 'INR'),
  paid_by text not null check (paid_by in ('company', 'customer_direct', 'not_yet')),
  payment_mode text check (payment_mode in ('bank_transfer', 'upi', 'card', 'cash', 'other')),
  paid_on date check (paid_on between date '2000-01-01' and date '2100-12-31'),
  reference text check (length(reference) between 1 and 120),
  receipt_evidence_id uuid references public.department_evidence (id),
  expense_status text check (expense_status in ('draft', 'submitted', 'accepted', 'returned')),
  submitted_by uuid references public.staff_profiles (user_id),
  submitted_at timestamptz,
  reviewed_by uuid references public.staff_profiles (user_id),
  reviewed_at timestamptz,
  return_reason text check (length(return_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  request_id uuid not null,
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (task_id, request_id),
  check ((paid_by = 'company') = (expense_status is not null)),
  check ((paid_by = 'not_yet') = (payment_mode is null and paid_on is null)),
  check ((expense_status in ('submitted', 'accepted', 'returned')) = (submitted_by is not null and submitted_at is not null)),
  check ((expense_status in ('accepted', 'returned')) = (reviewed_by is not null and reviewed_at is not null)),
  check ((expense_status = 'returned') = (return_reason is not null)),
  check (reviewed_by is null or (reviewed_by <> submitted_by and reviewed_by <> created_by))
);
create index department_cost_entries_task_idx on public.department_cost_entries (task_id);
create index department_cost_entries_deal_idx on public.department_cost_entries (deal_id);
create index department_cost_entries_review_idx on public.department_cost_entries (expense_status, submitted_at)
  where expense_status in ('submitted', 'accepted', 'returned');
create index department_cost_entries_receipt_idx on public.department_cost_entries (receipt_evidence_id) where receipt_evidence_id is not null;
create index department_cost_entries_submitted_by_idx on public.department_cost_entries (submitted_by) where submitted_by is not null;
create index department_cost_entries_reviewed_by_idx on public.department_cost_entries (reviewed_by) where reviewed_by is not null;
create index department_cost_entries_created_by_idx on public.department_cost_entries (created_by);
comment on table public.department_cost_entries is
  'Actual cost or fee recorded on a department task (the shared cost block). A company-paid entry is an expense record for Accounts review (recorded only: never a payment approval, payable or journal entry). Sales never reads it. No Data API read.';

-- Accepted entries are final; submitted entries change only by review.
create function authz.department_cost_entries_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cost entries cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.task_id is distinct from old.task_id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.department is distinct from old.department
     or new.request_id is distinct from old.request_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'cost entry identity columns are immutable' using errcode = '42501';
  end if;
  if old.expense_status = 'accepted' then
    raise exception 'accepted expense records are immutable' using errcode = '42501';
  end if;
  if old.expense_status = 'submitted' and new.expense_status not in ('accepted', 'returned', 'submitted') then
    raise exception 'a submitted expense record changes only by review' using errcode = '42501';
  end if;
  if old.expense_status = 'submitted'
     and (to_jsonb(new) - array['expense_status', 'reviewed_by', 'reviewed_at', 'return_reason', 'row_version', 'updated_at'])
         <> (to_jsonb(old) - array['expense_status', 'reviewed_by', 'reviewed_at', 'return_reason', 'row_version', 'updated_at']) then
    raise exception 'a submitted expense record changes only by review' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger department_cost_entries_a_guard
  before update or delete on public.department_cost_entries
  for each row execute function authz.department_cost_entries_guard();

alter table public.visa_applications enable row level security;
alter table public.department_evidence enable row level security;
alter table public.department_cost_entries enable row level security;
do $$
declare
  t text;
begin
  foreach t in array array['visa_applications', 'department_evidence', 'department_cost_entries'] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;
revoke all on public.visa_applications, public.department_evidence, public.department_cost_entries
from public, anon, authenticated, service_role;

-- Private bucket (no storage.objects policy; the server uses the secret key
-- after a database command authorized the actor).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('department-evidence', 'department-evidence', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

insert into public.permissions (code, description, is_grantable) values
  ('visa_task.read', 'See Visa & Passport desk tasks (visa and passport facts, applicants of the item).', false),
  ('visa_task.claim', 'Take a Visa & Passport desk task.', false),
  ('department_cost.record', 'Record the actual cost or fee of a department task and submit a company-paid one to Accounts.', false),
  ('expense.review', 'Accept or return a department expense record (never the submitter).', false);
insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('visa', 'visa_task.read', 'entity', 'proposed', 'B1.1c: the desk sees every visa/passport task in the entity'),
  ('visa', 'visa_task.claim', 'own', 'proposed', 'B1.1c: the desk takes a task'),
  ('visa', 'department_cost.record', 'own', 'proposed', 'B1.1c: on the task the person holds'),
  ('flight', 'department_cost.record', 'own', 'proposed', 'B1.1c: fare paid (direct payment up to INR 50,000, DEC-21)'),
  ('accounts', 'expense.review', 'entity', 'proposed', 'B1.1c: recorded only, not a payment approval');

-- ===========================================================================
-- 3. Authorization helpers
-- ===========================================================================

create function authz.can_read_visa_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'visa' and authz.holds_active_role('visa', t.legal_entity_id)
  )
$$;

create function authz.can_claim_visa_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_visa_task(p_task)
$$;

-- The task's assignee, holding the department's role, while the task is open.
create function authz.can_work_department_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.status = 'in_progress' and t.assignee_user_id = (select auth.uid())
      and authz.holds_active_role(t.department, t.legal_entity_id)
  )
$$;

-- Department readers of a task (its department's role holders) and the
-- branch Manager of the Deal (read only). Never Sales, Accounts or Super Admin
-- by this rule.
create function authz.can_read_department_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and (authz.holds_active_role(t.department, t.legal_entity_id) or authz.is_branch_sales_manager(t.deal_id))
  )
$$;

revoke all on function authz.can_read_visa_task(uuid), authz.can_claim_visa_task(uuid),
  authz.can_work_department_task(uuid), authz.can_read_department_task(uuid), authz.department_cost_entries_guard()
from public, anon, authenticated, service_role;
grant execute on function authz.can_read_visa_task(uuid), authz.can_claim_visa_task(uuid) to authenticated;

create policy visa_read on public.fulfilment_tasks
  for select to authenticated using (authz.can_read_visa_task(id));

-- Replaces 20261118000100: deal readers who hold a Visa role do not see the
-- other departments' tasks either.
create or replace function authz.can_read_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and (
        (t.department = 'purchase' and authz.holds_active_role('purchase', t.legal_entity_id))
        or (authz.can_read_deal(t.deal_id)
            and not authz.holds_role('purchase', t.legal_entity_id)
            and not authz.holds_role('flight', t.legal_entity_id)
            -- B1.1c
            and not authz.holds_role('visa', t.legal_entity_id))
      )
  )
$$;

-- Replaces 20261119000100: the assigned desk person may also save the
-- identity of the applicants on their open visa/passport task.
create or replace function authz.b11_can_edit_identity(p_deal uuid, p_seq integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_edit_booking_draft(p_deal) or exists (
    select 1 from public.fulfilment_tasks t
    where t.deal_id = p_deal and t.department = 'visa' and authz.can_work_department_task(t.id)
      and p_seq = any (authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id))))
$$;

-- Replaces 20261119000100: the one identity gate (review A5) adds the desk assignee.
create or replace function authz.can_read_traveller_identity(p_deal uuid, p_seq integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_seq is not null and (
    authz.can_edit_booking_draft(p_deal) or authz.can_confirm_booking(p_deal)
    -- B1.1c: the assigned desk person for the applicants of their open task.
    or authz.b11_can_edit_identity(p_deal, p_seq)
    or exists (
      select 1 from public.fulfilment_tasks t
      join public.booking_versions v on v.id = authz.task_current_version(t.id)  -- review R2
      where t.deal_id = p_deal and t.department = 'flight' and t.status = 'in_progress'
        and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('flight', t.legal_entity_id)
        and v.trip_scope = 'international'
        and exists (select 1 from public.service_item_travellers p
                    where p.service_item_id = t.service_item_id and p.traveller_seq = p_seq
                      and p.booking_version_id = (select c.id from public.booking_versions c
                                                  where c.deal_id = p_deal and c.status = 'confirmed'))))
$$;

-- An application is closed: issued with the documents back, or refused /
-- withdrawn and the customer told.
create function authz.visa_application_closed(a public.visa_applications) returns boolean
language sql immutable set search_path = '' as $$
  select (a.state = 'issued' and a.documents_returned_at is not null)
      or (a.state in ('refused', 'withdrawn') and a.customer_informed_at is not null)
$$;
revoke all on function authz.visa_application_closed(public.visa_applications) from public, anon, authenticated, service_role;

-- Applications follow the item's current participants (review V1): a new
-- participant gets an application; an open application of a traveller who no
-- longer takes part is closed as withdrawn (customer informed by the revision
-- itself) with an audit row. Issued or refused ones stay for the desk to finish.
create function authz.visa_sync_applications(p_task uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_seqs integer[];
  v_app record;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  if v_task.id is null or v_task.department <> 'visa' or v_task.status not in ('in_progress') then
    return;
  end if;
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, authz.task_current_version(v_task.id));
  insert into public.visa_applications (task_id, service_item_id, deal_id, legal_entity_id, traveller_seq, updated_by)
  select v_task.id, v_task.service_item_id, v_task.deal_id, v_task.legal_entity_id, s, (select auth.uid())
  from unnest(v_seqs) s
  on conflict (task_id, traveller_seq) do nothing;
  for v_app in
    update public.visa_applications a
    set state = 'withdrawn', customer_informed_at = now(), row_version = a.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    where a.task_id = v_task.id and not (a.traveller_seq = any (v_seqs))
      and a.state in ('docs_pending', 'submitted', 'decision_pending')
    returning a.id, a.traveller_seq
  loop
    perform authz.write_audit('visa.application_withdrawn_by_revision', v_task.legal_entity_id, v_task.branch_id,
      'visa_application', v_app.id, 'The traveller no longer takes part in this service (booking revised).',
      jsonb_build_object('taskId', v_task.id, 'seq', v_app.traveller_seq, 'versionId', authz.task_current_version(v_task.id)));
  end loop;
end;
$$;
revoke all on function authz.visa_sync_applications(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. JSON shapes
-- ===========================================================================

create function authz.department_evidence_json(p_task uuid, p_kinds text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'evidenceId', e.id, 'kind', e.kind, 'applicationId', e.application_id, 'fileName', e.file_name, 'mime', e.mime,
      'sizeBytes', e.size_bytes, 'status', e.status, 'uploadedByYou', e.uploaded_by = (select auth.uid()),
      'uploadedByName', p.display_name, 'createdAt', e.created_at, 'storedAt', e.stored_at) order by e.created_at, e.id), '[]'::jsonb)
  from public.department_evidence e
  left join public.staff_profiles p on p.user_id = e.uploaded_by
  where e.task_id = p_task and e.status <> 'removed' and (p_kinds is null or e.kind = any (p_kinds))
$$;

create function authz.department_cost_json(p_entry uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'entryId', c.id, 'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text, 'paidBy', c.paid_by,
    'paymentMode', c.payment_mode, 'paidOn', to_char(c.paid_on, 'YYYY-MM-DD'), 'reference', c.reference,
    'receiptEvidenceId', c.receipt_evidence_id, 'expenseStatus', c.expense_status, 'returnReason', c.return_reason,
    'submittedAt', c.submitted_at, 'reviewedAt', c.reviewed_at, 'rowVersion', c.row_version)
  from public.department_cost_entries c where c.id = p_entry
$$;

-- Applicants of a visa/passport task: the applications once taken, else the
-- item's participants. Identity fields only when p_identity.
create function authz.visa_applicants_json(p_task uuid, p_identity boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (
    select t.*, authz.task_current_version(t.id) as cur from public.fulfilment_tasks t where t.id = p_task
  ), seqs as (
    select a.traveller_seq as seq from public.visa_applications a join t on a.task_id = t.id
    union
    select s from t cross join unnest(authz.item_participant_seqs(t.service_item_id, t.cur)) s
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'applicationId', a.id, 'seq', q.seq, 'fullName', s.full_name, 'type', s.traveller_type, 'ageYears', s.age_years,
      'state', a.state, 'documents', coalesce(a.documents, '{}'::jsonb), 'reference', a.reference,
      'appointmentAt', a.appointment_at, 'appointmentPlace', a.appointment_place, 'submittedAt', a.submitted_at,
      'outcomeAt', a.outcome_at, 'customerInformedAt', a.customer_informed_at, 'documentsReturnedAt', a.documents_returned_at,
      'documentsReturnedByName', rp.display_name, 'rowVersion', a.row_version, 'closed', coalesce(authz.visa_application_closed(a), false))
    || case when p_identity then jsonb_build_object('identity', case when authz.can_read_traveller_identity(t.deal_id, q.seq) then coalesce((
         select jsonb_build_object('dateOfBirth', to_char(x.date_of_birth, 'YYYY-MM-DD'), 'nationality', x.nationality,
           'passportNumber', x.passport_number, 'passportExpiry', to_char(x.passport_expiry, 'YYYY-MM-DD'), 'rowVersion', x.row_version)
         from public.deal_travellers dt join public.traveller_identities x on x.traveller_id = dt.id
         where dt.deal_id = t.deal_id and dt.seq = q.seq), 'null'::jsonb) end) else '{}'::jsonb end
    order by q.seq), '[]'::jsonb)
  from seqs q
  cross join t
  left join public.visa_applications a on a.task_id = t.id and a.traveller_seq = q.seq
  left join public.booking_version_travellers s on s.booking_version_id = t.cur and s.seq = q.seq
  left join public.staff_profiles rp on rp.user_id = a.documents_returned_by
$$;

-- VisaTaskSummary / VisaTaskView. Visa or passport facts, the item's budget,
-- applicants; never a price, plan, claim, contact or billing value.
create function authz.visa_task_json(p_task uuid, p_detail boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'taskId', t.id,
    'dealReference', d.reference,
    'serviceType', i.service_type,
    'itemTitle', coalesce(nullif(authz.service_item_title(i.service_type, f.facts), ''), initcap(i.service_type) || ' ' || i.item_no::text),
    'facts', coalesce(f.facts, '{}'::jsonb),
    'purchaseBudgetPaise', coalesce(f.purchase_budget_paise, 0)::text,
    'status', t.status,
    'assigneeName', ap.display_name,
    'assignedToYou', t.assignee_user_id is not distinct from (select auth.uid()),
    'branchName', b.name,
    'createdAt', t.created_at,
    'completedAt', t.completed_at,
    'applicantCount', cardinality(authz.item_participant_seqs(t.service_item_id, v.id))
  ) || case when p_detail then jsonb_build_object(
    'versionNo', v.version_no,
    'confirmedAt', v.confirmed_at,
    'canClaim', authz.can_claim_visa_task(t.id) and t.assignee_user_id is null,
    'canWork', authz.can_work_department_task(t.id),
    'applicants', authz.visa_applicants_json(t.id, t.assignee_user_id is not distinct from (select auth.uid())),
    'evidence', authz.department_evidence_json(t.id, null),
    'costs', coalesce((select jsonb_agg(authz.department_cost_json(c.id) order by c.created_at, c.id)
                       from public.department_cost_entries c where c.task_id = t.id), '[]'::jsonb)
  ) else '{}'::jsonb end
  from public.fulfilment_tasks t
  join public.service_items i on i.id = t.service_item_id
  join public.booking_versions v on v.id = authz.task_current_version(t.id)
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
  join public.deals d on d.id = t.deal_id
  join public.branches b on b.id = t.branch_id
  left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
  where t.id = p_task
$$;

revoke all on function authz.department_evidence_json(uuid, text[]), authz.department_cost_json(uuid),
  authz.visa_applicants_json(uuid, boolean), authz.visa_task_json(uuid, boolean)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 5. Visa & Passport desk
-- ===========================================================================

create function public.visa_task_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.visa_task_json(t.id, false) order by t.created_at desc, t.id)
    from public.fulfilment_tasks t
    where t.department = 'visa' and authz.can_read_visa_task(t.id)
  ), '[]'::jsonb);
end;
$$;

create function public.visa_task_get(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_visa_task(p_task_id) then
    return null;
  end if;
  return authz.visa_task_json(p_task_id, true);
end;
$$;

-- Takes the task (like flight_task_claim) and opens one application per
-- applicant of the item (once).
create function public.visa_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not authz.can_claim_visa_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true, 'alreadyYours', true);
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'visa', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
  perform authz.visa_sync_applications(v_task.id);

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id,
      'serviceItemId', v_task.service_item_id, 'department', 'visa'));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true, 'alreadyYours', false);
end;
$$;

-- Locks an application and its task for work by the task's assignee.
create function authz.lock_visa_application(p_application uuid, p_expected_row_version integer)
returns public.visa_applications
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_task public.fulfilment_tasks%rowtype;
begin
  -- Lock order: task, then application.
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select a.task_id from public.visa_applications a where a.id = p_application) for update;
  select * into v_app from public.visa_applications a where a.id = p_application for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_app.id is null or v_task.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'completed' then
    raise exception 'task_closed' using errcode = '55000';
  end if;
  if not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if authz.visa_application_closed(v_app) then
    raise exception 'application_closed' using errcode = '55000';
  end if;
  return v_app;
end;
$$;

-- Completes the task when every current participant of the item has a
-- closed application and no other application is open (review V1); returns
-- whether it did.
create function authz.visa_task_complete_if_done(p_task uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_seqs integer[];
begin
  perform authz.visa_sync_applications(p_task);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, authz.task_current_version(v_task.id));
  if v_task.status <> 'in_progress' or cardinality(v_seqs) = 0
     or exists (select 1 from unnest(v_seqs) s
                where not exists (select 1 from public.visa_applications a
                                  where a.task_id = p_task and a.traveller_seq = s and authz.visa_application_closed(a)))
     or exists (select 1 from public.visa_applications a where a.task_id = p_task and not authz.visa_application_closed(a)) then
    return false;
  end if;
  update public.fulfilment_tasks t
  set status = 'completed', completed_by = (select auth.uid()), completed_at = now(), updated_at = now()
  where t.id = p_task;
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.task_completed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_item_id', v_task.service_item_id,
      'service_type', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;
  perform authz.write_audit('fulfilment.task_completed', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task',
    v_task.id, null, jsonb_build_object('dealId', v_task.deal_id, 'serviceItemId', v_task.service_item_id,
      'department', 'visa'));
  return true;
end;
$$;

revoke all on function authz.lock_visa_application(uuid, integer), authz.visa_task_complete_if_done(uuid)
from public, anon, authenticated, service_role;

-- Fires when a revision becomes the accepted version: every open desk task of
-- the Deal follows the new participants (review V1).
create function authz.visa_sync_after_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task uuid;
begin
  for v_task in
    select t.id from public.fulfilment_tasks t where t.deal_id = new.deal_id and t.department = 'visa' and t.status = 'in_progress'
  loop
    perform authz.visa_sync_applications(v_task);
    -- When the revision removed the last open applicant, the task is done now
    -- (no desk step is left to trigger it); completed_by is the confirmer.
    perform authz.visa_task_complete_if_done(v_task);
  end loop;
  return null;
end;
$$;
create trigger booking_versions_c_visa_sync
  after update of status on public.booking_versions
  for each row when (new.status = 'confirmed' and old.status = 'draft' and new.revises_version_id is not null)
  execute function authz.visa_sync_after_revision();
revoke all on function authz.visa_sync_after_revision() from public, anon, authenticated, service_role;

-- Checklist, reference and appointment. `documents` replaces the whole map
-- ({code: missing | received | checked}); keys absent from p_fields keep
-- their stored value.
create function public.visa_application_update(p_application_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_bad text[];
  v_docs jsonb;
  v_ref text;
  v_at timestamptz;
  v_place text;
begin
  v_app := authz.lock_visa_application(p_application_id, p_expected_row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['documents', 'reference', 'appointmentAt', 'appointmentPlace']);
  v_docs := case when p_fields ? 'documents' then p_fields -> 'documents' else v_app.documents end;
  if jsonb_typeof(v_docs) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(v_docs)) > 30
     or exists (select 1 from jsonb_each(v_docs) e
                where e.key !~ '^[a-z][a-z0-9_]{0,39}$' or jsonb_typeof(e.value) <> 'string'
                   or (e.value #>> '{}') not in ('missing', 'received', 'checked')) then
    v_bad := v_bad || 'documents'::text;
  end if;
  if p_fields ? 'reference' then
    if not authz.sf_text_ok(p_fields -> 'reference', 120, false) then v_bad := v_bad || 'reference'::text; end if;
    v_ref := authz.b11_text(p_fields -> 'reference');
  else
    v_ref := v_app.reference;
  end if;
  if p_fields ? 'appointmentAt' then
    begin
      v_at := case when jsonb_typeof(p_fields -> 'appointmentAt') = 'string' then (p_fields ->> 'appointmentAt')::timestamptz end;
    exception when others then
      v_bad := v_bad || 'appointmentAt'::text;
    end;
    if jsonb_typeof(p_fields -> 'appointmentAt') not in ('string', 'null') then v_bad := v_bad || 'appointmentAt'::text; end if;
  else
    v_at := v_app.appointment_at;
  end if;
  if p_fields ? 'appointmentPlace' then
    if not authz.sf_text_ok(p_fields -> 'appointmentPlace', 200, false) then v_bad := v_bad || 'appointmentPlace'::text; end if;
    v_place := authz.b11_text(p_fields -> 'appointmentPlace');
  else
    v_place := v_app.appointment_place;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  update public.visa_applications a
  set documents = v_docs, reference = v_ref, appointment_at = v_at, appointment_place = v_place,
      row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id
  returning * into v_app;
  perform authz.write_audit('visa.application_updated', v_app.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = v_app.deal_id), 'visa_application', v_app.id, null,
    jsonb_build_object('taskId', v_app.task_id, 'seq', v_app.traveller_seq, 'changedFields',
      to_jsonb(array(select k from jsonb_object_keys(p_fields) k order by k)), 'rowVersion', v_app.row_version));
  return jsonb_build_object('applicationId', v_app.id, 'rowVersion', v_app.row_version, 'state', v_app.state,
    'taskCompleted', false);
end;
$$;

-- Moves an application: submitted, decision_pending, issued, refused,
-- withdrawn, documents_returned, customer_informed. Issued and refused need a
-- stored authority document of this task (p_evidence_id).
create function public.visa_application_set_state(p_application_id uuid, p_expected_row_version integer, p_state text,
  p_evidence_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_from text;
  v_done boolean;
begin
  v_app := authz.lock_visa_application(p_application_id, p_expected_row_version);
  v_from := v_app.state;
  if p_state is null or p_state not in ('submitted', 'decision_pending', 'issued', 'refused', 'withdrawn',
                                         'documents_returned', 'customer_informed') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'state';
  end if;
  if p_state = 'submitted' then
    if v_app.state <> 'docs_pending' then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    if (select count(*) from jsonb_object_keys(v_app.documents)) = 0
       or exists (select 1 from jsonb_each_text(v_app.documents) e where e.value <> 'checked') then
      raise exception 'documents_not_checked' using errcode = '55000';
    end if;
    if v_app.reference is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'reference';
    end if;
    update public.visa_applications a set state = 'submitted', submitted_at = now() where a.id = v_app.id;
  elsif p_state = 'decision_pending' then
    if v_app.state <> 'submitted' then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    update public.visa_applications a set state = 'decision_pending' where a.id = v_app.id;
  elsif p_state in ('issued', 'refused') then
    if v_app.state not in ('submitted', 'decision_pending') then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    if p_evidence_id is null or not exists (
         select 1 from public.department_evidence e
         where e.id = p_evidence_id and e.task_id = v_app.task_id and e.kind = 'authority_outcome' and e.status = 'stored'
           and (e.application_id is null or e.application_id = v_app.id)) then
      raise exception 'outcome_document_required' using errcode = '55000';
    end if;
    update public.visa_applications a
    set state = p_state, outcome_evidence_id = p_evidence_id, outcome_at = now() where a.id = v_app.id;
  elsif p_state = 'withdrawn' then
    if v_app.state not in ('docs_pending', 'submitted', 'decision_pending') then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    update public.visa_applications a set state = 'withdrawn' where a.id = v_app.id;
  elsif p_state = 'documents_returned' then
    if v_app.state not in ('issued', 'refused') then
      raise exception 'outcome_required' using errcode = '55000';
    end if;
    update public.visa_applications a
    set documents_returned_at = now(), documents_returned_by = (select auth.uid()) where a.id = v_app.id;
  else
    if v_app.state not in ('refused', 'withdrawn') then
      raise exception 'outcome_required' using errcode = '55000';
    end if;
    update public.visa_applications a set customer_informed_at = now() where a.id = v_app.id;
  end if;
  update public.visa_applications a
  set row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id
  returning * into v_app;
  perform authz.write_audit('visa.application_state_changed', v_app.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = v_app.deal_id), 'visa_application', v_app.id, null,
    jsonb_build_object('taskId', v_app.task_id, 'seq', v_app.traveller_seq, 'from', v_from, 'to', p_state,
      'rowVersion', v_app.row_version));
  v_done := authz.visa_task_complete_if_done(v_app.task_id);
  return jsonb_build_object('applicationId', v_app.id, 'rowVersion', v_app.row_version, 'state', v_app.state,
    'taskCompleted', v_done);
end;
$$;

-- ===========================================================================
-- 6. Department evidence (mirrors purchase_evidence_*, 20261005000100)
-- ===========================================================================

create function public.department_evidence_begin(
  p_task_id uuid, p_application_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_max integer := coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304);
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status in ('completed', 'supplier_confirmed') then
    raise exception 'task_closed' using errcode = '55000';
  end if;
  if not authz.can_work_department_task(v_task.id) or v_task.department = 'purchase' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null
     or (v_task.department = 'visa' and p_kind not in ('applicant_document', 'fee_receipt', 'authority_outcome', 'other'))
     or (v_task.department = 'flight' and p_kind not in ('direct_payment_proof', 'other'))
     or (p_application_id is not null and not exists (
           select 1 from public.visa_applications a where a.id = p_application_id and a.task_id = v_task.id))
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and least(v_max, 4194304)
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed') >= 50 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.department_evidence (id, task_id, application_id, legal_entity_id, kind, object_path, file_name, mime,
    size_bytes, sha256, uploaded_by)
  values (v_id, v_task.id, p_application_id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()));
  perform authz.write_audit('department.evidence_started', v_task.legal_entity_id, v_task.branch_id,
    'department_evidence', v_id, null,
    jsonb_build_object('taskId', v_task.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

create function public.department_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ev public.department_evidence%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  -- Lock order everywhere: task, then evidence.
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.department_evidence e where e.id = p_evidence_id) for update;
  select * into v_ev from public.department_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_task.id is null or v_ev.uploaded_by is distinct from (select auth.uid())
     or not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_ev.status <> 'pending_upload' then
    if v_ev.status = v_status or (p_ok and v_ev.status = 'failed') then
      return jsonb_build_object('evidenceId', v_ev.id, 'status', v_ev.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'department-evidence' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;
  update public.department_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v_ev.id;
  perform authz.write_audit(case when v_status = 'stored' then 'department.evidence_stored' else 'department.evidence_failed' end,
    v_task.legal_entity_id, v_task.branch_id, 'department_evidence', v_ev.id, null,
    jsonb_build_object('taskId', v_task.id, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

create function public.department_evidence_remove(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ev public.department_evidence%rowtype;
begin
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.department_evidence e where e.id = p_evidence_id) for update;
  select * into v_ev from public.department_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_task.id is null or not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Evidence that proves an outcome or backs a submitted expense stays.
  if exists (select 1 from public.visa_applications a where a.outcome_evidence_id = v_ev.id)
     or exists (select 1 from public.department_cost_entries c
                where c.receipt_evidence_id = v_ev.id and c.expense_status in ('submitted', 'accepted')) then
    raise exception 'cost_locked' using errcode = '55000';
  end if;
  if v_ev.status = 'removed' then
    return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
  end if;
  update public.department_evidence e set status = 'removed', updated_at = now() where e.id = v_ev.id;
  perform authz.write_audit('department.evidence_removed', v_task.legal_entity_id, v_task.branch_id,
    'department_evidence', v_ev.id, null, jsonb_build_object('taskId', v_task.id, 'previousStatus', v_ev.status));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
end;
$$;

-- Download: the department's readers and the branch Manager; Accounts only
-- for a fee receipt or payment proof attached to an expense record it can
-- review. Applicant documents and outcomes never reach Accounts.
create function public.department_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.department_evidence%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_ok boolean;
begin
  select * into v_ev from public.department_evidence e where e.id = p_evidence_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_ev.task_id;
  v_ok := v_ev.id is not null and (
    authz.can_read_department_task(v_task.id)
    or (v_ev.kind in ('fee_receipt', 'direct_payment_proof') and exists (
          select 1 from public.department_cost_entries c join public.deals d on d.id = c.deal_id
          where c.receipt_evidence_id = v_ev.id and c.expense_status in ('submitted', 'accepted', 'returned')
            and authz.can_accounts(c.legal_entity_id) and not authz.holds_role('purchase', c.legal_entity_id)
            and authz.finance_gate_issue(c.legal_entity_id, d.is_synthetic) is null)));
  if not coalesce(v_ok, false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('department.evidence_viewed', v_ev.legal_entity_id, v_task.branch_id,
    'department_evidence', v_ev.id, null, jsonb_build_object('taskId', v_ev.task_id, 'kind', v_ev.kind));
  return jsonb_build_object('objectPath', v_ev.object_path, 'fileName', v_ev.file_name, 'mime', v_ev.mime);
end;
$$;

-- ===========================================================================
-- 7. Cost block and expense records
-- ===========================================================================

-- Creates (p_entry_id null) or edits a cost entry of the caller's open task.
-- Company-paid entries are expense records (status draft until submitted).
create function public.department_cost_save(p_task_id uuid, p_entry_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_old public.department_cost_entries%rowtype;
  v_entry public.department_cost_entries%rowtype;
  v_bad text[];
  v_kind text;
  v_amount bigint;
  v_paid text;
  v_mode text;
  v_on date;
  v_ref text;
  v_receipt uuid;
  v_status text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- B1.1c: Purchase gets the read-only placeholder only (B2/B3 build its costs).
  if v_task.department = 'purchase' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'department';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_entry_id is null then
    select * into v_old from public.department_cost_entries c where c.task_id = v_task.id and c.request_id = p_request_id;
    if v_old.id is not null then
      return jsonb_build_object('entryId', v_old.id, 'rowVersion', v_old.row_version, 'expenseStatus', v_old.expense_status);
    end if;
  else
    select * into v_old from public.department_cost_entries c where c.id = p_entry_id and c.task_id = v_task.id for update;
    if v_old.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    perform authz.require_row_version(p_expected_row_version, v_old.row_version);
    if v_old.expense_status in ('submitted', 'accepted') then
      raise exception 'cost_locked' using errcode = '55000';
    end if;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['costKind', 'amountPaise', 'paidBy', 'paymentMode', 'paidOn', 'reference',
    'receiptEvidenceId']);
  v_kind := authz.b11_text(p_fields -> 'costKind');
  if v_kind is null or v_kind not in ('government_fee', 'service_fee', 'fare', 'other')
     or (v_task.department = 'flight' and v_kind not in ('fare', 'other')) then
    v_bad := v_bad || 'costKind'::text;
  end if;
  if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
    v_amount := (p_fields ->> 'amountPaise')::bigint;
  else
    v_bad := v_bad || 'amountPaise'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  if v_paid is null or v_paid not in ('company', 'customer_direct', 'not_yet') then v_bad := v_bad || 'paidBy'::text; end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  v_on := authz.sf_date(p_fields -> 'paidOn');
  if v_paid = 'not_yet' then
    if v_mode is not null then v_bad := v_bad || 'paymentMode'::text; end if;
    if p_fields ? 'paidOn' and jsonb_typeof(p_fields -> 'paidOn') <> 'null' then v_bad := v_bad || 'paidOn'::text; end if;
  elsif v_paid is not null then
    if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other') then v_bad := v_bad || 'paymentMode'::text; end if;
    -- Business date in IST, as the finance commands (review E3).
    if v_on is null or v_on > authz.finance_today() then v_bad := v_bad || 'paidOn'::text; end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'reference', 120, false) then v_bad := v_bad || 'reference'::text; end if;
  v_ref := authz.b11_text(p_fields -> 'reference');
  if p_fields ? 'receiptEvidenceId' and jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'null' then
    begin
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
    exception when others then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end;
    if v_receipt is not null and not exists (
         select 1 from public.department_evidence e where e.id = v_receipt and e.task_id = v_task.id
           and e.kind in ('fee_receipt', 'direct_payment_proof') and e.status <> 'removed') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- DEC-21: a company-paid flight purchase above INR 50,000 goes through B3.
  -- Review V2: the cap is per purchase = every company-paid entry of the task
  -- (draft, submitted, accepted) together, under the task lock held above.
  if v_task.department = 'flight' and v_paid = 'company'
     and v_amount + coalesce((select sum(c.amount_paise) from public.department_cost_entries c
                              where c.task_id = v_task.id and c.paid_by = 'company'
                                and c.id is distinct from v_old.id
                                and c.expense_status in ('draft', 'submitted', 'accepted')), 0) > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;
  v_status := case when v_paid = 'company' then coalesce(case when v_old.expense_status = 'returned' then 'returned' end, 'draft') end;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, request_id, created_by)
    values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, v_task.department, v_kind, v_amount, v_paid,
      case when v_paid <> 'not_yet' then v_mode end, case when v_paid <> 'not_yet' then v_on end, v_ref, v_receipt, v_status,
      p_request_id, (select auth.uid()))
    returning * into v_entry;
  else
    update public.department_cost_entries c
    set cost_kind = v_kind, amount_paise = v_amount, paid_by = v_paid,
        payment_mode = case when v_paid <> 'not_yet' then v_mode end, paid_on = case when v_paid <> 'not_yet' then v_on end,
        reference = v_ref, receipt_evidence_id = v_receipt, expense_status = v_status,
        submitted_by = case when v_status = 'returned' then c.submitted_by end,
        submitted_at = case when v_status = 'returned' then c.submitted_at end,
        reviewed_by = case when v_status = 'returned' then c.reviewed_by end,
        reviewed_at = case when v_status = 'returned' then c.reviewed_at end,
        return_reason = case when v_status = 'returned' then c.return_reason end,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id
    returning * into v_entry;
  end if;
  -- No amount in the audit record.
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', v_task.department, 'costKind', v_kind,
      'paidBy', v_paid, 'rowVersion', v_entry.row_version));
  return jsonb_build_object('entryId', v_entry.id, 'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
end;
$$;

-- The receipt an expense record needs: a stored fee receipt (visa) or
-- direct-payment proof (flight) attached to the entry.
create function authz.expense_receipt_ok(p_entry uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.department_cost_entries c
    join public.department_evidence e on e.id = c.receipt_evidence_id and e.task_id = c.task_id and e.status = 'stored'
    where c.id = p_entry
      and e.kind = case when c.department = 'flight' then 'direct_payment_proof' else 'fee_receipt' end)
$$;
revoke all on function authz.expense_receipt_ok(uuid) from public, anon, authenticated, service_role;

create function public.department_cost_submit(p_entry_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_entry public.department_cost_entries%rowtype;
begin
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select c.task_id from public.department_cost_entries c where c.id = p_entry_id) for update;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_entry.id is null or not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_entry.row_version);
  if v_entry.expense_status is null or v_entry.expense_status not in ('draft', 'returned') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if not authz.expense_receipt_ok(v_entry.id) then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  -- Review V2: re-check the per-purchase cap (a returned entry may come back).
  if v_task.department = 'flight' and v_entry.amount_paise + coalesce((
       select sum(c.amount_paise) from public.department_cost_entries c
       where c.task_id = v_task.id and c.paid_by = 'company' and c.id <> v_entry.id
         and c.expense_status in ('draft', 'submitted', 'accepted')), 0) > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;
  update public.department_cost_entries c
  set expense_status = 'submitted', submitted_by = (select auth.uid()), submitted_at = now(),
      reviewed_by = null, reviewed_at = null, return_reason = null, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_entry.id
  returning * into v_entry;
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', v_task.department, 'costKind', v_entry.cost_kind,
      'rowVersion', v_entry.row_version));
  return jsonb_build_object('entryId', v_entry.id, 'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
end;
$$;

-- Accounts side (appendix B section 7; Mercury reviews). Recorded only:
-- never a journal entry, payable, approval or payment.
create function authz.finance_expense_review(p_entry uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid, p_accept boolean)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entry public.department_cost_entries%rowtype;
  v_deal public.deals%rowtype;
  v_command text := case when p_accept then 'expense_record_accept' else 'expense_record_return' end;
  v_payload jsonb := jsonb_build_object('entryId', p_entry, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  select * into v_entry from public.department_cost_entries c where c.id = p_entry;
  if v_entry.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = v_entry.deal_id;
  perform authz.finance_require_accounts(v_entry.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_entry.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry for update;
  if v_entry.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_entry.expense_status is distinct from 'submitted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_entry.submitted_by = (select auth.uid()) or v_entry.created_by = (select auth.uid())
     or authz.finance_deal_conflict(v_deal.id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not p_accept then
    v_reason := authz.finance_reason(p_reason);
  elsif not authz.expense_receipt_ok(v_entry.id) then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  update public.department_cost_entries c
  set expense_status = case when p_accept then 'accepted' else 'returned' end, reviewed_by = (select auth.uid()),
      reviewed_at = now(), return_reason = v_reason, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_entry.id
  returning * into v_entry;
  v_result := jsonb_build_object('outcome', 'updated', 'id', v_entry.id, 'entryId', v_entry.id,
    'status', v_entry.expense_status, 'rowVersion', v_entry.row_version);
  perform authz.finance_remember(v_entry.legal_entity_id, p_request_id, v_command, v_payload, v_result);
  perform authz.write_audit(case when p_accept then 'finance.expense_record_accepted' else 'finance.expense_record_returned' end,
    v_entry.legal_entity_id, v_entry.branch_id, 'department_cost_entry', v_entry.id, v_reason,
    jsonb_build_object('department', v_entry.department, 'costKind', v_entry.cost_kind, 'rowVersion', v_entry.row_version));
  return v_result;
end;
$$;
revoke all on function authz.finance_expense_review(uuid, integer, text, uuid, boolean)
from public, anon, authenticated, service_role;

create function public.expense_record_accept(p_entry_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  return authz.finance_expense_review(p_entry_id, p_expected_row_version, null, p_request_id, true);
end;
$$;

create function public.expense_record_return(p_entry_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  return authz.finance_expense_review(p_entry_id, p_expected_row_version, p_reason, p_request_id, false);
end;
$$;

create function authz.finance_expense_item_json(p_entry uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'entryId', c.id, 'dealId', c.deal_id, 'dealReference', d.reference, 'department', c.department,
    'serviceType', t.service_purpose, 'kind', c.cost_kind, 'amountPaise', c.amount_paise::text, 'paidBy', c.paid_by,
    'paymentMode', c.payment_mode, 'paidOn', to_char(c.paid_on, 'YYYY-MM-DD'), 'reference', c.reference,
    'status', c.expense_status, 'submittedByName', authz.finance_name(c.submitted_by), 'submittedAt', c.submitted_at,
    'reviewedByName', authz.finance_name(c.reviewed_by), 'reviewedAt', c.reviewed_at, 'returnReason', c.return_reason,
    'rowVersion', c.row_version,
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

-- Accounts list of expense records, paged like accounts_payment_claims.
create function public.accounts_expense_records(p_filter text, p_after text default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_after_id uuid;
  v_after_at timestamptz;
  v_result jsonb;
begin
  perform authz.finance_require_accounts_anywhere();
  if p_filter is null or p_filter not in ('submitted', 'returned', 'accepted', 'all') then
    perform authz.finance_invalid();
  end if;
  if p_after is not null then
    if length(p_after) < 38 or substr(p_after, 37, 1) <> ':'
       or substr(p_after, 1, 36) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or substr(p_after, 38) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then
      perform authz.finance_invalid();
    end if;
    v_after_id := substr(p_after, 1, 36)::uuid;
    begin
      v_after_at := substr(p_after, 38)::timestamptz;
    exception when others then
      perform authz.finance_invalid();
    end;
  end if;

  with gate as materialized (
    select e.id as legal_entity_id, s.is_synthetic
    from public.legal_entities e
    cross join (values (true), (false)) as s(is_synthetic)
    where authz.can_accounts(e.id)
      and authz.finance_gate_issue(e.id, s.is_synthetic) is null
  ), matched as (
    select c.id, c.submitted_at
    from public.department_cost_entries c
    join public.deals d on d.id = c.deal_id
    join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
    where c.expense_status in ('submitted', 'returned', 'accepted')
      and (p_filter = 'all' or c.expense_status = p_filter)
  ), page as (
    select m.id, m.submitted_at, row_number() over (order by m.submitted_at, m.id) as n
    from (select m.id, m.submitted_at from matched m
          where v_after_id is null or (m.submitted_at, m.id) > (v_after_at, v_after_id)
          order by m.submitted_at, m.id
          limit v_limit + 1) m
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(authz.finance_expense_item_json(p.id) order by p.n) from page p where p.n <= v_limit),
                      '[]'::jsonb),
    'hasMore', exists (select 1 from page p where p.n > v_limit),
    'nextAfter', case when exists (select 1 from page p where p.n > v_limit)
      then (select p.id::text || ':' || to_char(p.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            from page p where p.n = v_limit) end,
    'totalCount', (select count(*) from matched))
  into v_result;
  return v_result;
end;
$$;

-- Home count: submitted records the caller may review (not their own).
create function authz.finance_expenses_to_review_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'accounts'
         and authz.holds_active_role('accounts', m.legal_entity_id) and not authz.holds_role('purchase', m.legal_entity_id)) then
    return null;
  end if;
  with gate as materialized (
    select e.id as legal_entity_id, s.is_synthetic
    from public.legal_entities e
    cross join (values (true), (false)) as s(is_synthetic)
    where authz.can_accounts(e.id)
      and authz.finance_gate_issue(e.id, s.is_synthetic) is null
  )
  select count(*) into v_n
  from public.department_cost_entries c
  join public.deals d on d.id = c.deal_id
  join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
  where c.expense_status = 'submitted' and c.submitted_by <> (select auth.uid()) and c.created_by <> (select auth.uid());
  return v_n;
end;
$$;
revoke all on function authz.finance_expense_item_json(uuid), authz.finance_expenses_to_review_count()
from public, anon, authenticated, service_role;

-- The shared department work form of a task (contract section 4): steps,
-- references, documents and costs in one shape. Department readers and the
-- branch Manager; null for everyone else (Sales never sees costs).
create function public.department_work_form(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.can_read_department_task(v_task.id) then
    return null;
  end if;
  return jsonb_build_object(
    'taskId', v_task.id,
    'department', v_task.department,
    'status', v_task.status,
    'canWork', authz.can_work_department_task(v_task.id),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object('code', s.code, 'at', s.at, 'byName', s.by_name, 'seq', s.seq) order by s.at, s.ord)
      from (
        select 'taken' as code, v_task.updated_at as at, (select p.display_name from public.staff_profiles p
          where p.user_id = v_task.assignee_user_id) as by_name, null::integer as seq, 0 as ord
        where v_task.assignee_user_id is not null and v_task.department = 'visa'
        union all select 'submitted', a.submitted_at, null, a.traveller_seq, 1 from public.visa_applications a
          where a.task_id = v_task.id and a.submitted_at is not null
        union all select a.state, a.outcome_at, null, a.traveller_seq, 2 from public.visa_applications a
          where a.task_id = v_task.id and a.outcome_at is not null
        union all select 'customer_informed', a.customer_informed_at, null, a.traveller_seq, 3 from public.visa_applications a
          where a.task_id = v_task.id and a.customer_informed_at is not null
        union all select 'documents_returned', a.documents_returned_at, p.display_name, a.traveller_seq, 4
          from public.visa_applications a left join public.staff_profiles p on p.user_id = a.documents_returned_by
          where a.task_id = v_task.id and a.documents_returned_at is not null
        union all select 'completed', v_task.completed_at, (select p.display_name from public.staff_profiles p
          where p.user_id = v_task.completed_by), null, 5 where v_task.completed_at is not null
      ) s), '[]'::jsonb),
    'references', coalesce((
      select jsonb_agg(jsonb_build_object('kind', 'authority', 'value', a.reference, 'seq', a.traveller_seq) order by a.traveller_seq)
      from public.visa_applications a where a.task_id = v_task.id and a.reference is not null), '[]'::jsonb)
      || coalesce((
      select jsonb_agg(jsonb_build_object('kind', case when v_task.department = 'flight' then 'airline' else 'payment' end,
          'value', c.reference, 'seq', null) order by c.created_at)
      from public.department_cost_entries c where c.task_id = v_task.id and c.reference is not null), '[]'::jsonb),
    'documents', authz.department_evidence_json(v_task.id, null),
    'costs', coalesce((select jsonb_agg(authz.department_cost_json(c.id) order by c.created_at, c.id)
                       from public.department_cost_entries c where c.task_id = v_task.id), '[]'::jsonb));
end;
$$;

-- Replaces 20261119000100: completed visa work counts as done.
create or replace function authz.deal_progress_json(p_deal uuid, p_departments text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  with items as (
    select i.id, i.state, i.service_type, t.status
    from public.service_items i
    left join public.fulfilment_tasks t on t.service_item_id = i.id
    where i.deal_id = p_deal and i.state <> 'cancelled'
      and (p_departments is null or i.department = any (p_departments))
  ), counts as (
    select count(*) as total,
      count(*) filter (where status is null and not (state = 'active' and service_type in ('visa', 'passport'))) as planned,
      count(*) filter (where status is null and state = 'active' and service_type in ('visa', 'passport')) as waiting,
      count(*) filter (where status = 'not_started') as not_started,
      count(*) filter (where status = 'in_progress') as in_progress,
      count(*) filter (where status = 'supplier_confirmed') as supplier_confirmed,
      -- B1.1c
      count(*) filter (where status = 'completed') as completed
    from items
  )
  select jsonb_build_object(
    'total', c.total,
    'byState', jsonb_build_object('planned', c.planned, 'waitingForLaunch', c.waiting, 'notStarted', c.not_started,
      'inProgress', c.in_progress, 'supplierConfirmed', c.supplier_confirmed, 'completed', c.completed),
    'fulfilled', c.total > 0 and c.supplier_confirmed + c.completed = c.total,
    'staleCount', 0,
    'needs', (select coalesce(jsonb_agg(n.step order by n.ord), '[]'::jsonb) from (values
      ('confirm_version', 1), ('waiting_for_desk_launch', 2), ('take_task', 3), ('supplier_confirmation', 4)) as n(step, ord)
      where (n.step = 'confirm_version' and c.planned > 0)
         or (n.step = 'waiting_for_desk_launch' and c.waiting > 0)
         or (n.step = 'take_task' and c.not_started > 0)
         or (n.step = 'supplier_confirmation' and c.in_progress > 0)))
  from counts c
$$;

-- Replaces 20261119000100.
create or replace function authz.service_item_json(p_item uuid, p_version uuid, p_with_budget boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  with f as (
    select f.* from public.service_item_facts f
    where f.service_item_id = p_item
    order by (f.booking_version_id = p_version) desc, f.created_at desc, f.id desc
    limit 1
  ), t as (
    select t.*, p.display_name as assignee_name
    from public.fulfilment_tasks t
    left join public.staff_profiles p on p.user_id = t.assignee_user_id
    where t.service_item_id = p_item
    order by t.created_at desc
    limit 1
  )
  select jsonb_build_object(
    'itemId', i.id,
    'itemNo', i.item_no,
    'serviceType', i.service_type,
    'department', i.department,
    'state', i.state,
    'title', coalesce(nullif(authz.service_item_title(i.service_type, f.facts), ''),
                      initcap(i.service_type) || ' ' || i.item_no::text),
    'facts', jsonb_build_object('type', i.service_type, 'facts', coalesce(f.facts, '{}'::jsonb)),
    'factsHash', coalesce(f.facts_hash, repeat('0', 64)),
    'task', case when t.id is null then null else jsonb_build_object(
      'taskId', t.id,
      'status', t.status,
      'assigneeName', t.assignee_name,
      'assignedToYou', t.assignee_user_id is not distinct from (select auth.uid()),
      'supplierConfirmedAt', t.supplier_confirmed_at,
      'completedAt', t.completed_at) end,
    'nextStep', case
      -- B1.1
      when t.id is null and i.state = 'active' and i.service_type in ('visa', 'passport') then 'waiting_for_desk_launch'
      when t.id is null then 'confirm_version'
      when t.status = 'not_started' then 'take_task'
      -- B1.1c: the desk works the applications; completed is done.
      when t.status = 'in_progress' and i.department = 'visa' then 'visa_processing'
      when t.status = 'in_progress' then 'supplier_confirmation'
      else 'done' end)
  || case when p_with_budget then jsonb_build_object('purchaseBudgetPaise', coalesce(f.purchase_budget_paise, 0)::text)
          else '{}'::jsonb end
  from public.service_items i
  left join f on true
  left join t on true
  where i.id = p_item
$$;

-- Replaces 20261118000100: desk count, claims and expense records.
create or replace function public.my_work_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_sales boolean;
  v_manager boolean;
  v_purchase boolean;
  v_flight boolean;
  -- B1.1c
  v_visa boolean;
  v_visa_waiting integer;
  v_accounts boolean;
  v_waiting integer := 0;
  v_returned integer := 0;
  v_missing integer := 0;
  v_intake integer := 0;
  v_receipts integer;
  v_requests integer;
  v_n integer;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select
    bool_or(m.role_code = 'sales' and authz.holds_active_role('sales', m.legal_entity_id)),
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id)),
    bool_or(m.role_code = 'purchase' and authz.holds_active_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'flight' and authz.holds_active_role('flight', m.legal_entity_id)),
    bool_or(m.role_code = 'visa' and authz.holds_active_role('visa', m.legal_entity_id)),
    bool_or(m.role_code = 'accounts' and authz.holds_active_role('accounts', m.legal_entity_id)
            and not authz.holds_role('purchase', m.legal_entity_id))
  into v_sales, v_manager, v_purchase, v_flight, v_visa, v_accounts
  from public.memberships m where m.user_id = v_uid and m.status = 'active';

  -- Sales / Manager: drafts the caller may edit, their repair subset,
  -- returned reviews, and (while the prompt is on) confirmed Bitrix Deals
  -- without a booking.
  if coalesce(v_sales, false) or coalesce(v_manager, false) then
    select count(*), count(*) filter (where cardinality(authz.booking_issues(v.id)) > 0)
    into v_waiting, v_missing
    from public.booking_versions v
    where v.status = 'draft' and authz.can_edit_booking_draft(v.deal_id);
    select count(distinct d.id) into v_returned
    from public.deals d
    join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id and rv.status = 'returned'
    where d.removed_at is null
      and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
           or authz.is_branch_sales_manager(d.id));
    if coalesce((select s.intake_prompt_enabled from public.workflow_settings s where s.id), false) then
      select count(*) into v_intake
      from public.deals d
      where d.source_system = 'bitrix' and d.removed_at is null
        and authz.deal_in_trigger_stage(d.id)
        and not exists (select 1 from public.booking_versions v where v.deal_id = d.id)
        and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
             or authz.is_branch_sales_manager(d.id));
    end if;
  end if;

  -- Purchase: readable not-started purchase tasks plus own in-progress tasks.
  if coalesce(v_purchase, false) then
    select count(*) into v_n from public.fulfilment_tasks t
    where ((t.department = 'purchase' and t.status = 'not_started' and authz.can_read_purchase_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'purchase'));
    v_waiting := v_waiting + v_n;
  end if;
  -- Flight: the same for the flight department.
  if coalesce(v_flight, false) then
    select count(*) into v_n from public.fulfilment_tasks t
    where ((t.department = 'flight' and t.status = 'not_started' and authz.can_read_flight_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'flight'));
    v_waiting := v_waiting + v_n;
  end if;

  -- B1.1c Visa & Passport desk: readable not-started desk tasks plus own in-progress ones.
  if coalesce(v_visa, false) then
    select count(*) into v_visa_waiting from public.fulfilment_tasks t
    where ((t.department = 'visa' and t.status = 'not_started' and authz.can_read_visa_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'visa'));
    v_waiting := v_waiting + v_visa_waiting;
  end if;

  -- Accounts: accounts_queue('needs_review') row count and recorded receipts
  -- by someone else, over the queue's gate (entity x synthetic flag).
  if coalesce(v_accounts, false) then
    with gate as materialized (
      select e.id as legal_entity_id, s.is_synthetic
      from public.legal_entities e
      cross join (values (true), (false)) as s(is_synthetic)
      where authz.can_accounts(e.id)
        and authz.finance_gate_issue(e.id, s.is_synthetic) is null
    )
    select
      (select count(*)
       from public.deals d
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
       left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
       where coalesce(rv.status, 'pending') = 'pending'),
      (select count(*)
       from public.customer_receipts r
       join public.deals d on d.id = r.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where r.status = 'recorded' and r.recorded_by <> v_uid)
    into v_n, v_receipts;
    v_waiting := v_waiting + v_n;
  end if;

  if coalesce(v_manager, false) then
    v_requests := 0; -- B3
  end if;

  return jsonb_build_object(
    'waitingForMe', v_waiting,
    'returnedToMe', v_returned,
    'missingDetails', v_missing,
    'intakeNeeded', v_intake,
    'receiptsToVerify', v_receipts,
    'requestsToApprove', v_requests,
    -- B1.1c (freeze note 3.1): null when not applicable.
    'visaTasksWaiting', v_visa_waiting,
    'claimsToProcess', authz.finance_claims_to_process_count(),
    'expensesToReview', authz.finance_expenses_to_review_count());
end;
$$;

-- Replaces 20261118000100.
create or replace function public.booking_health() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entities uuid[];
  v_drafts integer;
  v_repair integer;
begin
  if not authz.can_admin_any('integration.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct m.legal_entity_id), '{}') into v_entities
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.status = 'active'
    and authz.can_admin('integration.manage', m.legal_entity_id);

  select count(*), count(*) filter (where cardinality(authz.booking_issues(v.id)) > 0)
  into v_drafts, v_repair
  from public.booking_versions v
  where v.status = 'draft' and v.legal_entity_id = any (v_entities);

  return jsonb_build_object(
    'realBookingEnabled', coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false),
    'environment', authz.deployment_environment(),
    'drafts', v_drafts,
    'draftsNeedingRepair', v_repair,
    'confirmed', (select count(*) from public.booking_versions v
                  where v.status = 'confirmed' and v.legal_entity_id = any (v_entities)),
    'tasksNotStarted', (select count(*) from public.fulfilment_tasks t
                        where t.status = 'not_started' and t.legal_entity_id = any (v_entities)),
    'tasksInProgress', (select count(*) from public.fulfilment_tasks t
                        where t.status = 'in_progress' and t.legal_entity_id = any (v_entities)),
    'pendingOutboxEvents', (select count(*) from public.outbox_events o
                            where o.status = 'pending' and o.legal_entity_id = any (v_entities)),
    -- B1: open (not supplier-confirmed) tasks per service type, and the switch.
    'tasksByServiceType', (select jsonb_build_object(
        'hotel', count(*) filter (where t.service_purpose = 'hotel'),
        'transfer', count(*) filter (where t.service_purpose = 'transfer'),
        'activity', count(*) filter (where t.service_purpose = 'activity'),
        'flight', count(*) filter (where t.service_purpose = 'flight'),
        -- B1.1c
        'visa', count(*) filter (where t.service_purpose = 'visa'),
        'passport', count(*) filter (where t.service_purpose = 'passport'))
      from public.fulfilment_tasks t
      where t.status not in ('supplier_confirmed', 'completed') and t.legal_entity_id = any (v_entities)),
    'visaPassportTasksEnabled', authz.visa_passport_tasks_enabled(),
    'serviceItemsEnabled', authz.service_items_enabled());
end;
$$;

-- Replaces 20261118000100: the desk switch is settable.
create or replace function public.admin_set_workflow_setting(p_key text, p_value boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.workflow_settings%rowtype;
  v_after public.workflow_settings%rowtype;
  v_reason text;
  v_prev text[];
  v_was boolean;
  v_now boolean;
  -- B1.1c
  v_created integer := 0;
  v_skipped integer := 0;
  v_item record;
  v_task uuid;
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_key is null or p_key not in ('intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled')
     or p_value is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_before from public.workflow_settings s where s.id for update;
  if v_before.id is null then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_workflow_setting', v_reason);
  update public.workflow_settings s
  set intake_prompt_enabled = case when p_key = 'intake_prompt_enabled' then p_value else s.intake_prompt_enabled end,
      service_items_enabled = case when p_key = 'service_items_enabled' then p_value else s.service_items_enabled end,
      visa_passport_tasks_enabled = case when p_key = 'visa_passport_tasks_enabled' then p_value
                                         else s.visa_passport_tasks_enabled end
  where s.id
  returning * into v_after;
  perform authz.settings_end_change(v_prev);

  v_was := case p_key when 'intake_prompt_enabled' then v_before.intake_prompt_enabled
                      when 'service_items_enabled' then v_before.service_items_enabled
                      else v_before.visa_passport_tasks_enabled end;
  v_now := case p_key when 'intake_prompt_enabled' then v_after.intake_prompt_enabled
                      when 'service_items_enabled' then v_after.service_items_enabled
                      else v_after.visa_passport_tasks_enabled end;
  -- B1.1c: switching the desk on creates each missing task once (accepted
  -- visa/passport items); removed and lost Deals are skipped and counted.
  -- Review V3: also when already on (repair: Deals active again, a confirm that
  -- raced the first switch-on). Idempotent by task key.
  if p_key = 'visa_passport_tasks_enabled' and v_now then
    for v_item in
      select i.id, i.deal_id, i.service_type, i.department, v.id as version_id, v.version_no, v.legal_entity_id, v.branch_id,
        (d.removed_at is not null or authz.deal_not_active(d.id)) as skip
      from public.service_items i
      join public.booking_versions v on v.deal_id = i.deal_id and v.status = 'confirmed'
      join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v.id
      join public.deals d on d.id = i.deal_id
      where i.service_type in ('visa', 'passport') and i.state = 'active'
        and not exists (select 1 from public.fulfilment_tasks t where t.service_item_id = i.id)
      order by i.deal_id, i.item_no
    loop
      if v_item.skip then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_task := null;
      insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key,
        created_by, service_item_id, department)
      values (v_item.deal_id, v_item.legal_entity_id, v_item.branch_id, v_item.version_id, v_item.service_type,
        'item:' || v_item.id::text || ':' || v_item.service_type, (select auth.uid()), v_item.id, 'visa')
      on conflict (task_key) do nothing
      returning id into v_task;
      if v_task is null then
        continue;
      end if;
      v_created := v_created + 1;
      insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
      values (v_item.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
        jsonb_build_object('task_id', v_task, 'version_id', v_item.version_id, 'deal_id', v_item.deal_id,
          'version_no', v_item.version_no, 'service_purpose', v_item.service_type,
          'service_item_id', v_item.id, 'service_type', v_item.service_type))
      on conflict (event_type, aggregate_id) do nothing;
      perform authz.write_audit('fulfilment.task_created', v_item.legal_entity_id, v_item.branch_id,
        'fulfilment_task', v_task, null,
        jsonb_build_object('dealId', v_item.deal_id, 'versionId', v_item.version_id, 'versionNo', v_item.version_no,
          'serviceItemId', v_item.id, 'serviceType', v_item.service_type, 'cause', 'desk_launch'));
    end loop;
  end if;
  return jsonb_build_object('key', p_key, 'changed', v_was is distinct from v_now, 'before', v_was, 'after', v_now,
    'updatedAt', v_after.updated_at)
    || case when p_key = 'visa_passport_tasks_enabled' then jsonb_build_object('tasksCreated', v_created, 'skipped', v_skipped)
            else '{}'::jsonb end;
end;
$$;

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function
  public.visa_task_list(), public.visa_task_get(uuid), public.visa_task_claim(uuid),
  public.visa_application_update(uuid, integer, jsonb), public.visa_application_set_state(uuid, integer, text, uuid),
  public.department_evidence_begin(uuid, uuid, text, text, text, integer, text),
  public.department_evidence_finish(uuid, boolean), public.department_evidence_remove(uuid),
  public.department_evidence_authorize_download(uuid),
  public.department_cost_save(uuid, uuid, integer, jsonb, uuid), public.department_cost_submit(uuid, integer),
  public.expense_record_accept(uuid, integer, uuid), public.expense_record_return(uuid, integer, text, uuid),
  public.accounts_expense_records(text, text, integer), public.department_work_form(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.visa_task_list(), public.visa_task_get(uuid), public.visa_task_claim(uuid),
  public.visa_application_update(uuid, integer, jsonb), public.visa_application_set_state(uuid, integer, text, uuid),
  public.department_evidence_begin(uuid, uuid, text, text, text, integer, text),
  public.department_evidence_finish(uuid, boolean), public.department_evidence_remove(uuid),
  public.department_evidence_authorize_download(uuid),
  public.department_cost_save(uuid, uuid, integer, jsonb, uuid), public.department_cost_submit(uuid, integer),
  public.expense_record_accept(uuid, integer, uuid), public.expense_record_return(uuid, integer, text, uuid),
  public.accounts_expense_records(text, text, integer), public.department_work_form(uuid)
to authenticated;

commit;
