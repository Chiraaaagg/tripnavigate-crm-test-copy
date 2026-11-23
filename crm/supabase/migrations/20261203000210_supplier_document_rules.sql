-- Accounts phase, Track B (2 of 6): supplier document rules.
-- Contract: implementation/accounts-phase-2026-11-10/contract.md sections
-- 6.2.2, 6.2.3, 7.3 and R16.6 (frozen 10 Nov 2026).
--
-- Changes:
--   * supplier_documents gains number_norm (upper case, letters and digits
--     only) and fiscal_year (Indian financial year of doc_date), both
--     generated, and credits_document_id (credit note -> its invoice,
--     set once).
--   * Duplicate rule: one non-returned document per (entity, supplier, kind,
--     number_norm, fiscal_year). The migration first counts existing
--     duplicates and stops with supplier_document_duplicates_exist when there
--     are any (no row is changed automatically); then the partial unique
--     index supplier_documents_no_duplicate is created.
--   * supplier_document_tasks: one bill linked to further Purchase/Flight
--     tasks or Deals (H11; task-level links, no amount split).
--   * Replaced (latest bodies, same signatures; Purchase and Flight behaviour
--     unchanged except the documented guards):
--       authz.sm_document_guard           (20261130000200) + credits_document_id set once
--       authz.sm_document_upload_flight   (20261201000210) + duplicate refusal, empty number,
--                                                           creditsDocumentId refused (invoices only)
--       public.supplier_document_upload   (20261201000210) + duplicate refusal, empty number,
--                                                           optional creditsDocumentId (credit notes)
--       authz.sm_invoice_missing          (20261201000210) "invoice exists" honours active links
--       public.accounts_supplier_documents (20261201000220) additive keys only:
--         linkedTaskCount, creditsDocumentId, creditsDocumentNumber
--   * New commands (security definer, execute to authenticated only):
--       public.supplier_document_link_task(p_document_id, p_task_id, p_request_id)   (S1)
--       public.supplier_document_unlink_task(p_link_id, p_reason, p_request_id)      (S2)
--       public.supplier_document_set_credit_link(p_document_id, p_invoice_id, p_request_id) (S3)
--
-- Refusal tokens (message is exactly the token): 23505
-- duplicate_supplier_document (hint number) | 55000 link_not_allowed (hint
-- taskId or documentId), already_recorded, wrong_state | 22023 invalid_input
-- (hint = field) | 42501 not_authorized | P0002 not_found | 40001
-- duplicate_request.
--
-- Audit rows (ids and kinds only): supplier.document_linked,
-- supplier.document_unlinked (reason), supplier.credit_note_linked.
--
-- Rollback (forward-only): a NEW migration restoring the four replaced
-- bodies from 20261130000200 / 20261201000210 / 20261201000220, dropping the
-- index supplier_documents_no_duplicate and revoking the three new commands.
-- Links and credit links stay (never deleted).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

alter table public.supplier_documents
  add column number_norm text generated always as (upper(regexp_replace(number, '[^A-Za-z0-9]', '', 'g'))) stored,
  add column fiscal_year text generated always as (authz.finance_fiscal_year(doc_date)) stored,
  add column credits_document_id uuid references public.supplier_documents (id),
  add constraint supplier_documents_credit_link_kind check (credits_document_id is null or kind = 'credit_note'),
  add constraint supplier_documents_credit_link_self check (credits_document_id is null or credits_document_id <> id);
create index supplier_documents_credits_idx on public.supplier_documents (credits_document_id)
  where credits_document_id is not null;
create index supplier_documents_number_norm_idx on public.supplier_documents (legal_entity_id, number_norm);

-- ===========================================================================
-- 2. Duplicate rule (stop when live data already holds duplicates)
-- ===========================================================================

do $$
declare
  v_groups integer;
begin
  select count(*) into v_groups from (
    select 1 from public.supplier_documents s
    where s.status <> 'returned'
    group by s.legal_entity_id, s.supplier_id, s.kind, s.number_norm, s.fiscal_year
    having count(*) > 1) g;
  if v_groups > 0 then
    raise exception 'supplier_document_duplicates_exist' using errcode = '23505',
      detail = format('%s duplicate group(s); the lead decides the fix-forward, no row was changed', v_groups);
  end if;
end;
$$;

create unique index supplier_documents_no_duplicate
  on public.supplier_documents (legal_entity_id, supplier_id, kind, number_norm, fiscal_year)
  where status <> 'returned';

-- ===========================================================================
-- 3. supplier_document_tasks (6.2.3)
-- ===========================================================================

create table public.supplier_document_tasks (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  document_id uuid not null references public.supplier_documents (id),
  task_id uuid not null,
  deal_id uuid not null,
  branch_id uuid not null,
  linked_by uuid not null references public.staff_profiles (user_id),
  linked_at timestamptz not null default now(),
  request_id uuid not null,
  unlinked_by uuid references public.staff_profiles (user_id),
  unlinked_at timestamptz,
  unlink_reason text check (unlink_reason is null or length(unlink_reason) between 10 and 500),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (legal_entity_id, request_id),
  check ((unlinked_at is null) = (unlinked_by is null) and (unlinked_at is null) = (unlink_reason is null))
);
create unique index supplier_document_tasks_active_key on public.supplier_document_tasks (document_id, task_id)
  where unlinked_at is null;
create index supplier_document_tasks_task_idx on public.supplier_document_tasks (task_id) where unlinked_at is null;
create index supplier_document_tasks_document_idx on public.supplier_document_tasks (document_id);
create index supplier_document_tasks_task_fk_idx on public.supplier_document_tasks (legal_entity_id, task_id);
create index supplier_document_tasks_deal_fk_idx on public.supplier_document_tasks (legal_entity_id, branch_id, deal_id);
create index supplier_document_tasks_deal_idx on public.supplier_document_tasks (deal_id);
create index supplier_document_tasks_linked_by_idx on public.supplier_document_tasks (linked_by);
create index supplier_document_tasks_unlinked_by_idx on public.supplier_document_tasks (unlinked_by) where unlinked_by is not null;
comment on table public.supplier_document_tasks is
  'Accounts phase (H11): a supplier bill linked to a further Purchase or Flight task (another Deal or another task). No amount split. Unlinked once with a reason; never deleted. No table grant.';

create function authz.supplier_document_tasks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier document links cannot be deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    select * into v_doc from public.supplier_documents s where s.id = new.document_id;
    if v_doc.id is null or v_doc.legal_entity_id <> new.legal_entity_id or v_doc.task_id = new.task_id then
      raise exception 'a supplier document link needs another task of the same company' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['unlinked_by', 'unlinked_at', 'unlink_reason'])
       is distinct from (to_jsonb(old) - array['unlinked_by', 'unlinked_at', 'unlink_reason'])
     or old.unlinked_at is not null then
    raise exception 'supplier document links are immutable once made or ended' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger supplier_document_tasks_a_guard before insert or update or delete on public.supplier_document_tasks
  for each row execute function authz.supplier_document_tasks_guard();

alter table public.supplier_document_tasks enable row level security;
create policy require_valid_session on public.supplier_document_tasks as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.supplier_document_tasks from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. Replaced guard and helpers
-- ===========================================================================

-- Replaces 20261130000200: unchanged, plus credits_document_id may change
-- only from null to a value (set once). Accounts phase (20261203000210).
create or replace function authz.sm_document_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- Accounts phase (20261203000210): + credits_document_id (set once below);
  -- number_norm and fiscal_year are generated (null in NEW of a BEFORE
  -- trigger) and follow number/doc_date, which stay compared.
  v_mutable text[] := array['status', 'return_reason', 'reviewed_by', 'reviewed_at', 'row_version', 'updated_at',
    'credits_document_id', 'number_norm', 'fiscal_year'];
begin
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or (new.status is distinct from old.status and old.status <> 'uploaded')
     -- Accounts phase (20261203000210): the credit link is set once.
     or (old.credits_document_id is not null and new.credits_document_id is distinct from old.credits_document_id) then
    raise exception 'supplier document facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- An invoice that is not returned exists on the task, or is linked to it.
create function authz.sm_task_has_invoice(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.supplier_documents s
                 where s.task_id = p_task and s.kind = 'invoice' and s.status <> 'returned')
      or exists (select 1 from public.supplier_document_tasks l
                 join public.supplier_documents s on s.id = l.document_id
                 where l.task_id = p_task and l.unlinked_at is null and s.kind = 'invoice' and s.status <> 'returned')
$$;
revoke all on function authz.sm_task_has_invoice(uuid) from public, anon, authenticated, service_role;

-- Replaces 20261201000210: the "invoice exists" test also accepts an active
-- link of a non-returned invoice to the task (Accounts phase 20261203000210).
create or replace function authz.sm_invoice_missing(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when t.department = 'flight' then coalesce(
           t.status = 'completed'
           and exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = t.id)
           and (select max(s.depart_date) from public.flight_sectors s
                where s.task_id = t.id and s.status = 'active') < authz.finance_today()
           and not authz.sm_task_has_invoice(t.id), false)  -- Accounts phase (20261203000210)
         else coalesce(authz.sm_task_confirmed(t.status)
           and authz.sm_trip_end(t.id) < authz.finance_today()
           and not authz.sm_task_has_invoice(t.id), false) end  -- Accounts phase (20261203000210)
  from public.fulfilment_tasks t where t.id = p_task
$$;

-- Normalised supplier document number (the generated column's expression).
create function authz.sm_number_norm(p_number text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_number, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Duplicate refusal before insert (the unique index is the race backstop).
create function authz.sm_document_refuse_duplicate(p_entity uuid, p_supplier uuid, p_kind text, p_number text, p_date date)
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if authz.sm_number_norm(p_number) = '' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'number';
  end if;
  if exists (select 1 from public.supplier_documents s
             where s.legal_entity_id = p_entity and s.supplier_id = p_supplier and s.kind = p_kind
               and s.number_norm = authz.sm_number_norm(p_number)
               and s.fiscal_year = authz.finance_fiscal_year(p_date) and s.status <> 'returned') then
    raise exception 'duplicate_supplier_document' using errcode = '23505', hint = 'number';
  end if;
end;
$$;
revoke all on function authz.sm_document_refuse_duplicate(uuid, uuid, text, text, date) from public, anon, authenticated, service_role;

-- The credit note's invoice: same entity and supplier, an invoice, not returned.
create function authz.sm_credit_target(p_entity uuid, p_supplier uuid, p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.supplier_documents s
                 where s.id = p_invoice and s.legal_entity_id = p_entity and s.supplier_id = p_supplier
                   and s.kind = 'invoice' and s.status <> 'returned')
$$;
revoke all on function authz.sm_credit_target(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 5. Replaced upload commands
-- ===========================================================================

-- Replaces 20261201000210. Unchanged except (Accounts phase 20261203000210):
-- creditsDocumentId in the allowlist (refused: flight uploads are invoices),
-- empty normalised number refused, duplicate refused.
create or replace function authz.sm_document_upload_flight(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_supplier uuid;
  v_kind text;
  v_number text;
  v_date date;
  v_total bigint;
  v_evidence uuid;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_gate text;
  v_constraint text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.flight_owns_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.flight_gate_issue(v_task.deal_id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['kind', 'number', 'docDate', 'totalPaise', 'gstIncluded', 'evidenceId', 'supplierId',
                          'creditsDocumentId']) <> '{}'::jsonb  -- Accounts phase (20261203000210)
     or jsonb_typeof(p_fields -> 'gstIncluded') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_kind := authz.finance_field(p_fields, 'kind');
  v_number := authz.finance_text(authz.finance_field(p_fields, 'number'), 1, 60, false);
  v_date := authz.finance_date(authz.finance_field(p_fields, 'docDate'));
  v_total := authz.finance_paise(p_fields, 'totalPaise', 1);
  v_evidence := authz.finance_uuid(authz.finance_field(p_fields, 'evidenceId'));
  v_supplier := authz.finance_uuid(authz.finance_field(p_fields, 'supplierId'));
  if v_kind is distinct from 'invoice' or v_number is null or v_date is null
     or v_date not between date '2000-01-01' and authz.finance_today() + 1
     or v_total is null or v_total > 999999999999999 or v_evidence is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Accounts phase (20261203000210): a credit link belongs to credit notes only.
  if authz.finance_field(p_fields, 'creditsDocumentId') is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end if;
  if not exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = v_task.id) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_supplier is null then
    if (select count(distinct b.supplier_id) from public.flight_ticket_batches b where b.cost_task_id = v_task.id) > 1 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
    end if;
    select b.supplier_id into v_supplier from public.flight_ticket_batches b where b.cost_task_id = v_task.id limit 1;
  elsif not exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = v_task.id and b.supplier_id = v_supplier) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
  end if;
  -- Accounts phase (20261203000210): duplicate refusal.
  perform authz.sm_document_refuse_duplicate(v_task.legal_entity_id, v_supplier, v_kind, v_number, v_date);
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_evidence and e.task_id = v_task.id and e.kind = v_kind and e.status = 'stored')
     or exists (select 1 from public.supplier_documents s where s.evidence_id = v_evidence) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  begin
    insert into public.supplier_documents (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number,
      doc_date, total_paise, gst_included, evidence_id, uploaded_by, request_id)
    values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_kind, v_number,
      v_date, v_total, (p_fields ->> 'gstIncluded')::boolean, v_evidence, (select auth.uid()), p_request_id);
  exception when unique_violation then
    -- Accounts phase (20261203000210): the race backstop.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'supplier_documents_no_duplicate' then
      raise exception 'duplicate_supplier_document' using errcode = '23505', hint = 'number';
    end if;
    raise;
  end;
  perform authz.write_audit('purchase.supplier_document_uploaded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('documentId', v_id, 'kind', v_kind, 'department', 'flight'));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'uploaded', 'rowVersion', 1);
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload, v_result);
end;
$$;
revoke all on function authz.sm_document_upload_flight(uuid, jsonb, uuid) from public, anon, authenticated, service_role;

-- Replaces 20261201000210. Unchanged except (Accounts phase 20261203000210):
-- optional creditsDocumentId (credit notes only: an invoice of the same
-- supplier and entity, not returned), empty normalised number refused,
-- duplicate refused.
create or replace function public.supplier_document_upload(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_gate text;
  v_kind text;
  v_number text;
  v_date date;
  v_total bigint;
  v_evidence uuid;
  v_credits uuid;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_constraint text;
begin
  -- Flight build (20261201000210).
  if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'flight') then
    return authz.sm_document_upload_flight(p_task_id, p_fields, p_request_id);
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department is distinct from 'purchase'
     or not coalesce(authz.session_ok(), false) or not authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['kind', 'number', 'docDate', 'totalPaise', 'gstIncluded', 'evidenceId',
                          'creditsDocumentId']) <> '{}'::jsonb  -- Accounts phase (20261203000210)
     or jsonb_typeof(p_fields -> 'gstIncluded') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_kind := authz.finance_field(p_fields, 'kind');
  v_number := authz.finance_text(authz.finance_field(p_fields, 'number'), 1, 60, false);
  v_date := authz.finance_date(authz.finance_field(p_fields, 'docDate'));
  v_total := authz.finance_paise(p_fields, 'totalPaise', 1);
  v_evidence := authz.finance_uuid(authz.finance_field(p_fields, 'evidenceId'));
  if v_kind is null or v_kind not in ('invoice', 'credit_note') or v_number is null or v_date is null
     or v_date not between date '2000-01-01' and authz.finance_today() + 1
     or v_total is null or v_total > 999999999999999 or v_evidence is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Accounts phase (20261203000210): optional credit link (credit notes only).
  begin
    v_credits := authz.finance_uuid(authz.finance_field(p_fields, 'creditsDocumentId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end;
  if v_credits is not null and v_kind <> 'credit_note' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select q.supplier_id into v_supplier from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_credits is not null and not authz.sm_credit_target(v_task.legal_entity_id, v_supplier, v_credits) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end if;
  -- Accounts phase (20261203000210): duplicate refusal.
  perform authz.sm_document_refuse_duplicate(v_task.legal_entity_id, v_supplier, v_kind, v_number, v_date);
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_evidence and e.task_id = v_task.id and e.kind = v_kind and e.status = 'stored')
     or exists (select 1 from public.supplier_documents s where s.evidence_id = v_evidence) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  begin
    insert into public.supplier_documents (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number,
      doc_date, total_paise, gst_included, evidence_id, uploaded_by, request_id, credits_document_id)
    values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_kind, v_number,
      v_date, v_total, (p_fields ->> 'gstIncluded')::boolean, v_evidence, (select auth.uid()), p_request_id, v_credits);
  exception when unique_violation then
    -- Accounts phase (20261203000210): the race backstop.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'supplier_documents_no_duplicate' then
      raise exception 'duplicate_supplier_document' using errcode = '23505', hint = 'number';
    end if;
    raise;
  end;
  perform authz.write_audit('purchase.supplier_document_uploaded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('documentId', v_id, 'kind', v_kind));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'uploaded', 'rowVersion', 1);
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 6. Link commands (S1-S3)
-- ===========================================================================

-- The target task can carry a bill of this supplier: Purchase = the task's
-- agreed cost quote is with that supplier; Flight = the task is the cost task
-- of a batch with that supplier.
create function authz.sm_link_eligible(p_task uuid, p_supplier uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(case t.department
    when 'purchase' then exists (select 1 from public.purchase_quotes q
                                 where q.id = (authz.purchase_agreed_cost(t.id)).quote_id and q.supplier_id = p_supplier)
    when 'flight' then exists (select 1 from public.flight_ticket_batches b
                               where b.cost_task_id = t.id and b.supplier_id = p_supplier)
    else false end, false)
  from public.fulfilment_tasks t where t.id = p_task
$$;
revoke all on function authz.sm_link_eligible(uuid, uuid) from public, anon, authenticated, service_role;

-- S1: Accounts of the entity, or the assignee of the TARGET task holding its
-- department role while the document is still uploaded.
create function public.supplier_document_link_task(p_document_id uuid, p_task_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_synthetic boolean;
  v_is_accounts boolean;
  v_gate text;
  v_link public.supplier_document_tasks%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'taskId', p_task_id);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_document_id is null or p_task_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = case when p_document_id is null then 'documentId' else 'taskId' end;
  end if;
  select * into v_doc from public.supplier_documents s where s.id = p_document_id;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_doc.id is null or v_task.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_doc.deal_id;
  v_is_accounts := authz.sm_accounts_sees(v_doc.legal_entity_id, v_synthetic);
  if not v_is_accounts then
    if v_task.legal_entity_id <> v_doc.legal_entity_id or v_doc.status <> 'uploaded' then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_task.department = 'purchase' then
      if v_task.assignee_user_id is distinct from (select auth.uid())
         or v_task.status not in ('in_progress', 'supplier_confirmed', 'completed')
         or not authz.holds_active_role('purchase', v_task.legal_entity_id) then
        raise exception 'not_authorized' using errcode = '42501';
      end if;
      v_gate := authz.procurement_gate_issue(v_task.id);
    elsif v_task.department = 'flight' then
      if not authz.flight_owns_task(v_task.id) then
        raise exception 'not_authorized' using errcode = '42501';
      end if;
      v_gate := authz.flight_gate_issue(v_task.deal_id);
    else
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  end if;

  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_doc from public.supplier_documents s where s.id = p_document_id for update;
  v_result := authz.sm_replay(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_doc.status = 'returned' or (not v_is_accounts and v_doc.status <> 'uploaded') then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'documentId';
  end if;
  if v_task.legal_entity_id <> v_doc.legal_entity_id or v_task.id = v_doc.task_id
     or v_task.department not in ('purchase', 'flight')
     or not authz.sm_link_eligible(v_task.id, v_doc.supplier_id) then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'taskId';
  end if;

  select * into v_link from public.supplier_document_tasks l
  where l.document_id = v_doc.id and l.task_id = v_task.id and l.unlinked_at is null;
  if v_link.id is not null then
    v_result := jsonb_build_object('outcome', 'existing', 'linkId', v_link.id, 'documentId', v_doc.id,
      'taskId', v_task.id, 'dealId', v_task.deal_id);
    return authz.sm_remember(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload, v_result);
  end if;

  insert into public.supplier_document_tasks (legal_entity_id, document_id, task_id, deal_id, branch_id, linked_by, request_id)
  values (v_doc.legal_entity_id, v_doc.id, v_task.id, v_task.deal_id, v_task.branch_id, (select auth.uid()), p_request_id)
  returning * into v_link;
  perform authz.write_audit('supplier.document_linked', v_doc.legal_entity_id, v_task.branch_id, 'supplier_document', v_doc.id,
    null, jsonb_build_object('documentId', v_doc.id, 'taskId', v_task.id, 'dealId', v_task.deal_id, 'linkId', v_link.id));
  v_result := jsonb_build_object('outcome', 'created', 'linkId', v_link.id, 'documentId', v_doc.id,
    'taskId', v_task.id, 'dealId', v_task.deal_id);
  return authz.sm_remember(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload, v_result);
end;
$$;

-- S2: Accounts only.
create function public.supplier_document_unlink_task(p_link_id uuid, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_link public.supplier_document_tasks%rowtype;
  v_synthetic boolean;
  v_reason text;
  v_payload jsonb := jsonb_build_object('linkId', p_link_id, 'reason', p_reason);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_link from public.supplier_document_tasks l where l.id = p_link_id;
  if v_link.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_link.deal_id;
  perform authz.finance_require_accounts(v_link.legal_entity_id, v_synthetic);
  perform authz.finance_lock_deal(v_link.deal_id);
  select * into v_link from public.supplier_document_tasks l where l.id = p_link_id for update;
  v_result := authz.sm_replay(v_link.legal_entity_id, p_request_id, 'supplier_document_unlink_task', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if v_link.unlinked_at is not null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  update public.supplier_document_tasks l
  set unlinked_by = (select auth.uid()), unlinked_at = now(), unlink_reason = v_reason
  where l.id = v_link.id;
  perform authz.write_audit('supplier.document_unlinked', v_link.legal_entity_id, v_link.branch_id, 'supplier_document',
    v_link.document_id, v_reason, jsonb_build_object('documentId', v_link.document_id, 'taskId', v_link.task_id,
      'dealId', v_link.deal_id, 'linkId', v_link.id));
  v_result := jsonb_build_object('outcome', 'updated', 'linkId', v_link.id, 'documentId', v_link.document_id,
    'taskId', v_link.task_id);
  return authz.sm_remember(v_link.legal_entity_id, p_request_id, 'supplier_document_unlink_task', v_payload, v_result);
end;
$$;

-- S3: Accounts only; a credit note without a link, an invoice of the same
-- supplier and entity that is not returned.
create function public.supplier_document_set_credit_link(p_document_id uuid, p_invoice_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
  v_synthetic boolean;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'invoiceId', p_invoice_id);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_doc from public.supplier_documents s where s.id = p_document_id;
  if v_doc.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_doc.deal_id;
  perform authz.finance_require_accounts(v_doc.legal_entity_id, v_synthetic);
  perform authz.finance_lock_deal(v_doc.deal_id);
  select * into v_doc from public.supplier_documents s where s.id = p_document_id for update;
  v_result := authz.sm_replay(v_doc.legal_entity_id, p_request_id, 'supplier_document_set_credit_link', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_doc.kind <> 'credit_note' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'documentId';
  end if;
  if v_doc.credits_document_id is not null then
    raise exception 'already_recorded' using errcode = '55000';
  end if;
  if p_invoice_id is null or not authz.sm_credit_target(v_doc.legal_entity_id, v_doc.supplier_id, p_invoice_id) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'invoiceId';
  end if;
  update public.supplier_documents s
  set credits_document_id = p_invoice_id, row_version = s.row_version + 1, updated_at = now()
  where s.id = v_doc.id
  returning * into v_doc;
  perform authz.write_audit('supplier.credit_note_linked', v_doc.legal_entity_id, v_doc.branch_id, 'supplier_document', v_doc.id,
    null, jsonb_build_object('documentId', v_doc.id, 'invoiceId', p_invoice_id, 'rowVersion', v_doc.row_version));
  v_result := jsonb_build_object('outcome', 'updated', 'id', v_doc.id, 'creditsDocumentId', p_invoice_id,
    'rowVersion', v_doc.row_version);
  return authz.sm_remember(v_doc.legal_entity_id, p_request_id, 'supplier_document_set_credit_link', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 7. accounts_supplier_documents: additive keys
-- ===========================================================================

-- Replaces 20261201000220: unchanged, plus linkedTaskCount, creditsDocumentId
-- and creditsDocumentNumber on each document (Accounts phase 20261203000210).
create or replace function public.accounts_supplier_documents(p_tab text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  perform authz.finance_require_accounts_anywhere();
  if p_tab is null or p_tab not in ('to_review', 'missing', 'all') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'documents', case when p_tab = 'missing' then '[]'::jsonb else coalesce((
      select jsonb_agg(authz.sm_document_json(x.id) || jsonb_build_object(
               'branchName', x.branch_name,
               'canReview', x.status = 'uploaded' and x.uploaded_by <> v_uid,
               'department', x.department,
               -- Accounts phase (20261203000210)
               'linkedTaskCount', (select count(*) from public.supplier_document_tasks l
                                   where l.document_id = x.id and l.unlinked_at is null),
               'creditsDocumentId', x.credits_document_id,
               'creditsDocumentNumber', (select c.number from public.supplier_documents c where c.id = x.credits_document_id))
             order by x.ord)
      from (
        select s.id, s.status, s.uploaded_by, b.name as branch_name, s.credits_document_id,
          case when t.department = 'flight' then 'flight' else 'purchase' end as department,
          row_number() over (order by s.uploaded_at desc, s.id) as ord
        from public.supplier_documents s
        join public.deals d on d.id = s.deal_id
        join public.branches b on b.id = s.branch_id
        join public.fulfilment_tasks t on t.id = s.task_id
        where authz.sm_accounts_sees(s.legal_entity_id, d.is_synthetic)
          and (p_tab = 'all' or s.status = 'uploaded')
        order by s.uploaded_at desc, s.id
        limit 500
      ) x), '[]'::jsonb) end,
    'missingInvoices', case when p_tab = 'to_review' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
               'taskId', y.id,
               'dealReference', y.reference,
               'serviceTitle', coalesce(authz.sm_task_title(y.id), 'Service'),
               'supplierId', y.supplier_id,
               'supplierName', y.supplier_name,
               'tripEnd', to_char(y.trip_end, 'YYYY-MM-DD'),
               'assigneeName', y.assignee_name,
               'department', y.department) order by y.trip_end, y.id)
      from (
        (select t.id, d.reference, q.supplier_id, s.name as supplier_name, authz.sm_trip_end(t.id) as trip_end,
          ap.display_name as assignee_name, 'purchase'::text as department
        from public.fulfilment_tasks t
        join public.deals d on d.id = t.deal_id
        left join public.purchase_quotes q on q.id = t.selected_quote_id
        left join public.suppliers s on s.id = q.supplier_id
        left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
        where t.department = 'purchase' and t.status in ('supplier_confirmed', 'completed')
          and authz.sm_accounts_sees(t.legal_entity_id, d.is_synthetic)
          and authz.sm_invoice_missing(t.id)
        limit 500)
        union all
        (select t.id, d.reference, fb.supplier_id, s.name, authz.sm_trip_end(t.id),
          ap.display_name, 'flight'::text
        from public.fulfilment_tasks t
        join public.deals d on d.id = t.deal_id
        left join lateral (select b.supplier_id from public.flight_ticket_batches b
                           where b.cost_task_id = t.id order by b.batch_no limit 1) fb on true
        left join public.suppliers s on s.id = fb.supplier_id
        left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
        where t.department = 'flight' and t.status = 'completed'
          and authz.sm_accounts_sees(t.legal_entity_id, d.is_synthetic)
          and authz.sm_invoice_missing(t.id)
        limit 500)
      ) y), '[]'::jsonb) end);
end;
$$;

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function authz.supplier_document_tasks_guard(), authz.sm_number_norm(text)
  from public, anon, authenticated, service_role;
revoke all on function public.supplier_document_link_task(uuid, uuid, uuid),
  public.supplier_document_unlink_task(uuid, text, uuid),
  public.supplier_document_set_credit_link(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.supplier_document_link_task(uuid, uuid, uuid),
  public.supplier_document_unlink_task(uuid, text, uuid),
  public.supplier_document_set_credit_link(uuid, uuid, uuid)
  to authenticated;

commit;
