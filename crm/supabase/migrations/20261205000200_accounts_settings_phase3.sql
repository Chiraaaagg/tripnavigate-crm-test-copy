-- TripNavigate CRM - Accounts phase 3, track B (1 of 4): settings and the
-- write-off and automatic-bill schema.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 6.1, 6.2 (schema
-- part), 6.3 (change_open stub), 6.6 (deal_write_offs), 14, 17.1, 17.2, 19
-- (shared-function rule), 21 LD11-LD16, Addenda O1 and L1.
--
-- Lands early on purpose: track C (Tally file) and track D (notices) read the
-- objects created here.
--
-- 1. accounts_settings gains auto_bills_enabled (Off), auto_bill_release_enabled
--    (On by default, owner 17.1; effective only while customer_documents_enabled
--    and auto_bills_enabled are on), write_off_enabled (Off),
--    write_off_limit_paise (500000 = Rs 5,000, 1..500000), tally_xml_enabled
--    (Off) and tally_company_name (null; both written only by track C's setter
--    C2). authz.accounts_settings_audit (replaces 20261204000200:57) lists every
--    column (names only, never values). public.admin_accounts_settings
--    (replaces 20261203000250:563) returns them.
-- 2. B1 public.admin_set_auto_bills(p_entity, p_drafts, p_release, p_reason) and
--    B2 public.admin_set_write_off(p_entity, p_enabled, p_limit_paise, p_reason):
--    finance policy managers (authz.can_manage_finance_policy); reason 10..500;
--    audit settings.accounts_changed (trigger, column names only).
-- 3. customer_documents: auto_rule, auto_state (ready | held, drafts only),
--    hold_reasons (the 6.3 codes), evaluated_at, release_rule, end_rule;
--    created_by and released_by nullable (a row made or released by the CRM
--    carries the rule instead); customer_document_render_jobs.requested_by
--    nullable. A BEFORE UPDATE trigger clears auto_state / hold_reasons when a
--    draft leaves draft (release, discard). cdoc_auto_pending: the fallback
--    list of Deals whose automatic run failed (the sweep retries them).
--    Deviation (reported to the lead): end_rule is not in contract 6.2. An
--    automatic release of a replacement marks the replaced document 'replaced'
--    with no person (timer run); the Phase 2 check needs ended_by, so the check
--    now reads "ended_by is not null or end_rule is not null".
-- 4. deal_write_offs + write_off_counters (WO-YYYY-NNNNNN per entity and year),
--    guard (no DELETE; facts immutable; proposed -> approved | returned |
--    withdrawn, approved -> undone), one active write-off per Deal.
-- 5. authz.deal_change_open(p_deal uuid) returns boolean: STUB returning false.
--    Track G replaces it (same signature) - contract 6.3 / 19.
--
-- Refusal tokens: not_authorized (42501), invalid_input (22023, hint names the
-- field). Guards raise 42501 with a plain message.
--
-- Rollback (forward-only): a NEW migration restoring
-- authz.accounts_settings_audit (20261204000200) and
-- public.admin_accounts_settings (20261203000250) and revoking the B1 / B2
-- setters; columns and tables stay (older code never reads them). Never delete
-- rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Settings columns (6.1)
-- ===========================================================================

alter table public.accounts_settings
  add column auto_bills_enabled boolean not null default false,
  add column auto_bill_release_enabled boolean not null default true,
  add column write_off_enabled boolean not null default false,
  add column write_off_limit_paise bigint not null default 500000
    constraint accounts_settings_write_off_limit_check check (write_off_limit_paise between 1 and 500000),
  add column tally_xml_enabled boolean not null default false,
  add column tally_company_name text
    constraint accounts_settings_tally_company_name_check
      check (tally_company_name is null or (char_length(tally_company_name) between 1 and 100
                                            and tally_company_name !~ '[[:cntrl:]]'));

-- Accounts phase 3 (20261205000200): the column list covers every switch.
create or replace function authz.accounts_settings_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cols text[] := array[]::text[];
  v_col text;
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_new jsonb := to_jsonb(new);
  v_reason text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_reason', true), ''), E' \t\r\n'), ''), 500);
  v_command text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_command', true), ''), E' \t\r\n'), ''), 100);
begin
  foreach v_col in array array['exception_owner_user_id', 'tally_export_enabled',
                               'customer_documents_enabled', 'refunds_enabled',
                               -- Accounts phase 3 (20261205000200)
                               'auto_bills_enabled', 'auto_bill_release_enabled', 'write_off_enabled',
                               'write_off_limit_paise', 'tally_xml_enabled', 'tally_company_name'] loop
    if tg_op = 'INSERT' or (v_old -> v_col) is distinct from (v_new -> v_col) then
      v_cols := v_cols || v_col;
    end if;
  end loop;
  if tg_op = 'UPDATE' and cardinality(v_cols) = 0 then
    return null;
  end if;
  perform authz.write_audit('settings.accounts_changed', new.legal_entity_id, null, 'accounts_settings', new.legal_entity_id,
    v_reason, jsonb_build_object('operation', lower(tg_op), 'columns', to_jsonb(v_cols), 'command', v_command,
      'rowVersion', new.row_version));
  return null;
end;
$$;

-- Accounts phase 3 (20261205000200): additive keys for every Phase 2 and Phase 3 switch.
create or replace function public.admin_accounts_settings(p_entity uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.accounts_settings%rowtype;
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    return null;
  end if;
  select * into v from public.accounts_settings s where s.legal_entity_id = p_entity;
  return jsonb_build_object(
    'entityId', p_entity,
    'exceptionOwnerUserId', v.exception_owner_user_id,
    'exceptionOwnerName', (select p.display_name from public.staff_profiles p where p.user_id = v.exception_owner_user_id),
    'exceptionOwnerActive', authz.acct_exception_owner(p_entity) is not null,
    'tallyExportEnabled', coalesce(v.tally_export_enabled, false),
    -- Accounts phase 3 (20261205000200)
    'customerDocumentsEnabled', coalesce(v.customer_documents_enabled, false),
    'refundsEnabled', coalesce(v.refunds_enabled, false),
    'autoBillsEnabled', coalesce(v.auto_bills_enabled, false),
    'autoBillReleaseEnabled', coalesce(v.auto_bill_release_enabled, true),
    'writeOffEnabled', coalesce(v.write_off_enabled, false),
    'writeOffLimitPaise', coalesce(v.write_off_limit_paise, 500000)::text,
    'tallyXmlEnabled', coalesce(v.tally_xml_enabled, false),
    'tallyCompanyName', v.tally_company_name,
    'rowVersion', coalesce(v.row_version, 0),
    'updatedAt', v.updated_at,
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.display_name) order by p.display_name, p.user_id)
      from public.staff_profiles p
      where authz.is_active_department_person(p.user_id, p_entity, 'accounts')
        and not exists (select 1 from public.memberships m where m.user_id = p.user_id and m.legal_entity_id = p_entity
                        and m.role_code = 'purchase' and m.status = 'active')), '[]'::jsonb));
end;
$$;

-- B1: automatic bill drafts and automatic release (6.1).
create function public.admin_set_auto_bills(p_entity uuid, p_drafts boolean, p_release boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.accounts_settings%rowtype;
  v_after public.accounts_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if p_drafts is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'drafts';
  end if;
  if p_release is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'release';
  end if;
  select * into v_before from public.accounts_settings s where s.legal_entity_id = p_entity for update;
  v_prev := authz.settings_begin_change('admin_set_auto_bills', v_reason);
  insert into public.accounts_settings as s (legal_entity_id, auto_bills_enabled, auto_bill_release_enabled, updated_by)
  values (p_entity, p_drafts, p_release, (select auth.uid()))
  on conflict (legal_entity_id) do update
    set auto_bills_enabled = excluded.auto_bills_enabled, auto_bill_release_enabled = excluded.auto_bill_release_enabled,
        updated_by = excluded.updated_by, updated_at = now(), row_version = s.row_version + 1
    where s.auto_bills_enabled is distinct from excluded.auto_bills_enabled
       or s.auto_bill_release_enabled is distinct from excluded.auto_bill_release_enabled
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  if v_after.legal_entity_id is null then
    select * into v_after from public.accounts_settings s where s.legal_entity_id = p_entity;
  end if;
  return jsonb_build_object(
    'changed', coalesce(v_before.auto_bills_enabled, false) is distinct from p_drafts
               or coalesce(v_before.auto_bill_release_enabled, true) is distinct from p_release,
    'autoBillsEnabled', v_after.auto_bills_enabled, 'autoBillReleaseEnabled', v_after.auto_bill_release_enabled,
    'rowVersion', v_after.row_version, 'updatedAt', v_after.updated_at);
end;
$$;

-- B2: write-off switch and limit per Deal (6.1, 6.6).
create function public.admin_set_write_off(p_entity uuid, p_enabled boolean, p_limit_paise bigint, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.accounts_settings%rowtype;
  v_after public.accounts_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  if p_limit_paise is null or p_limit_paise not between 1 and 500000 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limitPaise';
  end if;
  select * into v_before from public.accounts_settings s where s.legal_entity_id = p_entity for update;
  v_prev := authz.settings_begin_change('admin_set_write_off', v_reason);
  insert into public.accounts_settings as s (legal_entity_id, write_off_enabled, write_off_limit_paise, updated_by)
  values (p_entity, p_enabled, p_limit_paise, (select auth.uid()))
  on conflict (legal_entity_id) do update
    set write_off_enabled = excluded.write_off_enabled, write_off_limit_paise = excluded.write_off_limit_paise,
        updated_by = excluded.updated_by, updated_at = now(), row_version = s.row_version + 1
    where s.write_off_enabled is distinct from excluded.write_off_enabled
       or s.write_off_limit_paise is distinct from excluded.write_off_limit_paise
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  if v_after.legal_entity_id is null then
    select * into v_after from public.accounts_settings s where s.legal_entity_id = p_entity;
  end if;
  return jsonb_build_object(
    'changed', coalesce(v_before.write_off_enabled, false) is distinct from p_enabled
               or coalesce(v_before.write_off_limit_paise, 500000) is distinct from p_limit_paise,
    'writeOffEnabled', v_after.write_off_enabled, 'writeOffLimitPaise', v_after.write_off_limit_paise::text,
    'rowVersion', v_after.row_version, 'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 2. Customer documents: automatic fields (6.2)
-- ===========================================================================

alter table public.customer_documents
  add column auto_rule text constraint customer_documents_auto_rule_check
    check (auto_rule is null or auto_rule ~ '^[a-z][a-z0-9_.]{2,59}$'),
  add column auto_state text constraint customer_documents_auto_state_check
    check (auto_state is null or auto_state in ('ready', 'held')),
  add column hold_reasons text[] not null default array[]::text[] constraint customer_documents_hold_reasons_check
    check (array_position(hold_reasons, null) is null and hold_reasons <@ array['company_identity_missing', 'billing_not_verified',
      'amount_mismatch', 'amount_zero', 'newer_version_waiting', 'receipt_not_money', 'cancellation_open', 'change_open',
      'refund_open', 'duplicate_cover', 'number_conflict']::text[]),
  add column evaluated_at timestamptz,
  add column release_rule text constraint customer_documents_release_rule_check
    check (release_rule is null or release_rule ~ '^[a-z][a-z0-9_.]{2,59}$'),
  add column end_rule text constraint customer_documents_end_rule_check
    check (end_rule is null or end_rule ~ '^[a-z][a-z0-9_.]{2,59}$');

alter table public.customer_documents
  add constraint customer_documents_auto_state_draft
    check (auto_state is null or (status = 'draft' and auto_rule is not null)),
  add constraint customer_documents_hold_reasons_held
    check (cardinality(hold_reasons) = 0 or auto_state = 'held'),
  add constraint customer_documents_release_rule_released
    check (release_rule is null or status in ('released', 'replaced', 'cancelled')),
  add constraint customer_documents_end_rule_ended
    check (end_rule is null or status in ('replaced', 'cancelled', 'discarded'));

-- created_by / released_by / ended_by: a person, or the rule of the CRM.
alter table public.customer_documents alter column created_by drop not null;
alter table public.customer_documents
  add constraint customer_documents_created_by_or_rule check (created_by is not null or auto_rule is not null);

do $$
declare
  c record;
begin
  -- The Phase 2 release and end checks (auto-named) name released_by / ended_by.
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.customer_documents'::regclass and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) like '%released_by IS NOT NULL%'
           or pg_get_constraintdef(con.oid) like '%ended_by IS NOT NULL%')
      and con.conname not in ('customer_documents_created_by_or_rule')
  loop
    execute format('alter table public.customer_documents drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.customer_documents
  add constraint customer_documents_release_recorded
    check ((status in ('released', 'replaced', 'cancelled'))
      = (released_at is not null and (released_by is not null or release_rule is not null)
         and issue_date is not null and release_request_id is not null)),
  add constraint customer_documents_end_recorded
    check ((status in ('replaced', 'cancelled', 'discarded'))
      = (ended_at is not null and (ended_by is not null or end_rule is not null) and end_reason is not null));

alter table public.customer_document_render_jobs alter column requested_by drop not null;

-- "Bills to check" (held automatic drafts, oldest first) and the sweep order.
create index customer_documents_auto_drafts_idx on public.customer_documents (legal_entity_id, auto_state, created_at, id)
  where status = 'draft' and auto_rule is not null;
create index customer_documents_auto_sweep_idx on public.customer_documents (evaluated_at)
  where status = 'draft' and auto_rule is not null;

-- Leaving draft (release, discard) ends the automatic state.
create function authz.customer_documents_auto_clear() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status <> 'draft' then
    new.auto_state := null;
    new.hold_reasons := array[]::text[];
  end if;
  return new;
end;
$$;
create trigger customer_documents_b_auto_clear before update on public.customer_documents
  for each row when (old.status = 'draft' and new.status is distinct from old.status)
  execute function authz.customer_documents_auto_clear();

comment on column public.customer_documents.auto_rule is
  'Accounts phase 3: the rule that drafted this document by itself (adv_on_receipt, inv_on_approval, inv_replace_on_change, cn_on_refund); null = made by a person.';
comment on column public.customer_documents.release_rule is
  'Accounts phase 3: the rule that released this document by itself (released_by is then null).';

-- Fallback list (6.2): a Deal whose automatic run failed; the sweep retries it.
create table public.cdoc_auto_pending (
  deal_id uuid primary key references public.deals (id),
  reason_code text not null check (reason_code ~ '^[A-Za-z0-9_]{1,40}$'),
  attempts integer not null default 1 check (attempts >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cdoc_auto_pending_created_idx on public.cdoc_auto_pending (created_at);
comment on table public.cdoc_auto_pending is
  'Accounts phase 3 (6.2): Deals whose automatic bill run failed (SQLSTATE code only); retried by the timer task customer_documents_auto_sweep. No table grant.';

-- ===========================================================================
-- 3. Write-offs (6.6, LD15, LD16)
-- ===========================================================================

create table public.write_off_counters (
  legal_entity_id uuid not null references public.legal_entities (id),
  year integer not null check (year between 2000 and 2100),
  last_no integer not null default 0 check (last_no between 0 and 999999),
  primary key (legal_entity_id, year)
);
comment on table public.write_off_counters is
  'Accounts phase 3: last WO-YYYY-NNNNNN number per entity and India-time year (row locked when numbering). No table grant.';

create function authz.write_off_counters_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'write-off counters cannot be deleted' using errcode = '42501';
  end if;
  if new.legal_entity_id is distinct from old.legal_entity_id or new.year is distinct from old.year or new.last_no < old.last_no then
    raise exception 'write-off counters only move forward' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger write_off_counters_a_guard before update or delete on public.write_off_counters
  for each row execute function authz.write_off_counters_guard();

create table public.deal_write_offs (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  ref_no text not null check (ref_no ~ '^WO-[0-9]{4}-[0-9]{6}$'),
  -- due: the customer still owes it and it is waived; excess: the customer overpaid it and it is kept.
  direction text not null check (direction in ('due', 'excess')),
  amount_paise bigint not null check (amount_paise >= 1),
  reason text not null check (char_length(reason) between 10 and 500),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'returned', 'withdrawn', 'undone')),
  proposed_by uuid not null references public.staff_profiles (user_id),
  proposed_at timestamptz not null default now(),
  request_id uuid not null,
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  decision_request_id uuid,
  return_reason text check (return_reason is null or char_length(return_reason) between 10 and 500),
  undone_by uuid references public.staff_profiles (user_id),
  undone_at timestamptz,
  undo_reason text check (undo_reason is null or char_length(undo_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (legal_entity_id, ref_no),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id),
  check (decided_by is distinct from proposed_by),
  check ((status in ('approved', 'returned', 'undone')) = (decided_by is not null and decided_at is not null)),
  check ((status = 'returned') = (return_reason is not null)),
  check ((status = 'undone') = (undone_by is not null and undone_at is not null and undo_reason is not null))
);
-- One active write-off per Deal (LD16).
create unique index deal_write_offs_one_active on public.deal_write_offs (deal_id) where status in ('proposed', 'approved');
create index deal_write_offs_deal_idx on public.deal_write_offs (deal_id, proposed_at desc);
create index deal_write_offs_deal_fk_idx on public.deal_write_offs (legal_entity_id, branch_id, deal_id);
create index deal_write_offs_entity_status_idx on public.deal_write_offs (legal_entity_id, status, decided_at);
create index deal_write_offs_branch_month_idx on public.deal_write_offs (branch_id, decided_at) where status = 'approved';
create index deal_write_offs_proposed_by_idx on public.deal_write_offs (proposed_by);
create index deal_write_offs_decided_by_idx on public.deal_write_offs (decided_by) where decided_by is not null;
create index deal_write_offs_undone_by_idx on public.deal_write_offs (undone_by) where undone_by is not null;
comment on table public.deal_write_offs is
  'Accounts phase 3 (LD15): a dues adjustment of a small leftover balance (due) or overpayment (excess); never a journal entry, money held never changes. Accounts proposes, a branch Manager approves. No table grant.';

create function authz.deal_write_offs_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_fixed text[] := array['id', 'legal_entity_id', 'branch_id', 'deal_id', 'ref_no', 'direction', 'amount_paise', 'reason',
    'proposed_by', 'proposed_at', 'request_id'];
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  k text;
begin
  if tg_op = 'DELETE' then
    raise exception 'write-offs cannot be deleted' using errcode = '42501';
  end if;
  foreach k in array v_fixed loop
    if (v_old -> k) is distinct from (v_new -> k) then
      raise exception 'write-off facts are immutable' using errcode = '42501';
    end if;
  end loop;
  if new.row_version <> old.row_version + 1 then
    raise exception 'write-off row version must step by one' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'proposed' and new.status in ('approved', 'returned', 'withdrawn'))
       or (old.status = 'approved' and new.status = 'undone')) then
    raise exception 'write-off status move not allowed' using errcode = '42501';
  end if;
  if new.status = old.status then
    raise exception 'write-offs change only by a status move' using errcode = '42501';
  end if;
  -- A decision, once made, stays; an undo records only the undo columns.
  if old.status <> 'proposed' and ((v_new -> 'decided_by') is distinct from (v_old -> 'decided_by')
       or (v_new -> 'decided_at') is distinct from (v_old -> 'decided_at')
       or (v_new -> 'decision_request_id') is distinct from (v_old -> 'decision_request_id')
       or (v_new -> 'return_reason') is distinct from (v_old -> 'return_reason')) then
    raise exception 'write-off decision is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger deal_write_offs_a_guard before update or delete on public.deal_write_offs
  for each row execute function authz.deal_write_offs_guard();
create trigger deal_write_offs_no_truncate before truncate on public.deal_write_offs
  for each statement execute function authz.refuse_settings_truncate();

-- ===========================================================================
-- 4. Change-in-progress stub (6.3 change_open, 6.6; track G replaces it)
-- ===========================================================================

-- STUB (contract 6.3 / 19): no change request can exist before track G, so
-- nothing is ever "in progress". Track G replaces this function with the
-- same signature (a live change request: requested | returned | approved |
-- submitted).
create function authz.deal_change_open(p_deal uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return false;
end;
$$;

-- ===========================================================================
-- 5. Row level security and grants
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['cdoc_auto_pending', 'write_off_counters', 'deal_write_offs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function
  authz.customer_documents_auto_clear(), authz.write_off_counters_guard(), authz.deal_write_offs_guard(),
  authz.deal_change_open(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.admin_set_auto_bills(uuid, boolean, boolean, text),
  public.admin_set_write_off(uuid, boolean, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.admin_set_auto_bills(uuid, boolean, boolean, text),
  public.admin_set_write_off(uuid, boolean, bigint, text)
  to authenticated;

commit;
