-- TripNavigate CRM - Direction A Batch 3: standalone referral drafts, audited
-- linking, scoped Quotations and Itineraries lists, 90-day closure.
--
-- Contract: docs/implementation/frontend-redesign-2026-10-15/contracts.md
--   section B as amended by F.3 (closure), F.5a (DEC-52..54) and F.6 (N2:
--   authorization before draft_closed); F.1.4 case 6 (referral clearing);
--   plan.md section 3 (A4, A5, M3) and 12b; feature-parity FP-040..FP-055,
--   FP-081; money-privacy-settings (M3). Shapes: Atlas notes
--   atlas-batch3-shapes.md (v2).
--
-- What changes:
--   1. Switch workflow_settings.referral_drafts (default false) and
--      referral_auto_close_resumed_at, set by a BEFORE UPDATE trigger on every
--      off -> on change (DEC-53), whichever path makes it. The settings audit
--      trigger is recreated from its latest column list (20261122000100) plus
--      both new columns. admin_set_workflow_setting and workflow_settings_get
--      (latest bodies 20261122000100) accept / report the new key.
--   2. Tables referral_draft_counters, referral_drafts (TD-n per legal entity;
--      minimal customer fields; open | closed; last_activity_at) and
--      referral_draft_links (append-only link history, one active link per
--      kind). RLS on, restrictive session policy, no select policy, no
--      privilege; no deletes; identity immutable.
--   3. quotations.referral_draft_id and itinerary_documents.referral_draft_id:
--      a third explicit subject kind. The "exactly one subject" checks are
--      replaced, never relaxed.
--   4. Access (B.3): authz.referral_draft_can_edit = no Purchase role in the
--      entity and (owner with active Sales in the branch, or branch Manager,
--      or the editors of an ACTIVELY linked Deal / Lead). Accounts, Purchase,
--      Flight, Visa & Passport and Super Admin by role get nothing. Money
--      (M3): the draft owner with own-scope deal.read_commercial, entity scope
--      or a branch grant of it, and after binding the bound Deal's
--      commercial readers; never Purchase, never Super Admin by role.
--   5. Closure (F.3): one cutoff authz.referral_due_on = IST date of
--      greatest(last_activity_at, referral_auto_close_resumed_at) + 91; due
--      while the switch is on, the draft is stored open, nothing of it is
--      bound or converted and authz.finance_today() >= dueOn. Switch off: no
--      closure anywhere. Every write on a referral subject checks
--      authorization first (unlocked read), then locks the draft row (lock
--      order draft -> quotation -> version / itinerary -> Deal) and refuses
--      draft_closed having written nothing; success moves last_activity_at
--      (exception: unlink, lead ruling Q1, works on a closed draft).
--      Only the job, referral_draft_reopen and referral_draft_close persist
--      an automatic closure, each with a committed structured outcome. The
--      job is created PAUSED (authz.provision_referral_close_job, owner SQL).
--   6. Commands: quotation_create_standalone, itinerary_create_standalone,
--      referral_draft_save / _close / _reopen / _reassign / _link / _unlink,
--      referral_drafts_close_inactive (service_role); quotation_create and
--      itinerary_document_create accept subject 'referral'; quotation_link_deal
--      binds a referral quotation to the draft's actively linked Deal
--      (binding stays separate from conversion).
--   7. Reads: work_drafts_list (scoped Quotations / Itineraries lists, exact
--      counts naming scope, keyset pages), referral_draft_get,
--      referral_draft_find, referral_link_candidates,
--      referral_owner_candidates, referral_drafts_for_subject; my_work_counts
--      and my_work_list gain the FP-081 rows (same predicate as the list).
--   8. Replaced bodies, each copied from its LATEST definition with the lines
--      marked "Batch 3" (see section 8 for the source file of each).
--
-- Switch Off = today's behaviour for every existing command (no creation of
-- drafts; existing Lead / Deal quotations and itineraries take exactly the old
-- paths, because every new branch is gated on referral_draft_id).
--
-- Refusal tokens added (message is exactly the token):
--   55000 referral_drafts_disabled, draft_closed, draft_not_closed,
--         draft_already_linked, link_locked, deal_not_linked_to_draft
--   Existing: not_authorized, invalid_input, version_changed,
--   request_conflict, branch_mismatch, deal_not_from_lead,
--   deal_already_linked, deal_removed, deal_not_active, settings_busy.
--
-- Never: links by name, mobile or e-mail; writes to Bitrix; opens a booking,
-- creates tasks, finance rows or outbox rows on link; deletes anything.
--
-- Any later migration that replaces a function below must copy THIS body.
--
-- Apply history: disposable local and CI stacks only. Amended in place on
-- 21 October 2026 (lead ruling Q1, after commit 30a4a81 and before any kept or
-- live database applied it): referral_draft_unlink also works on a closed
-- draft, without reopening it or counting as activity; referral_draft_get
-- can.unlink / links[].canRemove follow. Amended again the same day (Echo-B
-- M5): quotation_list accepts subject kind 'referral' (the draft's
-- quotations with every version, for the draft's editors), and the draft
-- summary in quotation_get / itinerary_document_get gains ownerIsYou and
-- ownerName. Amended again the same day after the Echo-A data review
-- (echo-redesign-batch3-data.md): M1 the job's candidate query leaves bound
-- or converted drafts out; M2 (lead ruling) a document on a referral draft
-- compares only with the draft's own accepted quotation, else nothing; L1
-- idempotent link / unlink / reassign answers come before the row-version
-- check; L2 activity moves only when a command writes (audit-row trigger);
-- L3 one work-set scan per list page; L4 Lead / Deal owner names only for
-- viewers who can read that record; L5 a concurrent duplicate create
-- answers as a replay; L6 duplicate hints use the effective state, and an
-- insert guard keeps a draft document in the draft's branch; and (Echo L9)
-- itinerary list rows gain ownerIsYou for the owner whose name they show. No
-- signature change.
--
-- Rollback (forward-only): keep the switch off (creation refused, nothing
-- closes). A new migration may revoke execute on the new commands and reads
-- and restore the replaced bodies from the files named in section 8. Rows are
-- kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch
-- ===========================================================================

alter table public.workflow_settings
  add column referral_drafts boolean not null default false,
  add column referral_auto_close_resumed_at timestamptz;
comment on column public.workflow_settings.referral_drafts is
  'Batch 3: staff may create referral drafts (quotations and itineraries without a Bitrix record) and the 90-day closure runs. Off: no new drafts, no closure; existing drafts keep working (DEC-54). Switching on needs the owner''s APPROVE.';
comment on column public.workflow_settings.referral_auto_close_resumed_at is
  'Batch 3 (DEC-53): set by trigger whenever referral_drafts goes from off to on; the 90 days count from the later of this time and the draft''s last activity.';

-- Echo M2: every path that turns the switch on restarts the clock.
create function authz.referral_resume_clock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not old.referral_drafts and new.referral_drafts then
    new.referral_auto_close_resumed_at := now();
  end if;
  return new;
end;
$$;
create trigger workflow_settings_referral_resume before update on public.workflow_settings
  for each row execute function authz.referral_resume_clock();

-- F.6 N1: the latest column list (20261122000100) plus the two new columns.
drop trigger workflow_settings_audit on public.workflow_settings;
create trigger workflow_settings_audit
  after insert or update or delete on public.workflow_settings
  for each row execute function authz.audit_settings_change(
    'settings.workflow_changed', 'intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled',
    'prefill_auto_fill', 'referral_drafts', 'referral_auto_close_resumed_at');

create function authz.referral_drafts_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.referral_drafts from public.workflow_settings s where s.id), false)
$$;

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

create table public.referral_draft_counters (
  legal_entity_id uuid primary key references public.legal_entities (id),
  last_no integer not null default 0 check (last_no >= 0)
);

create table public.referral_drafts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  draft_no integer not null check (draft_no >= 1),
  reference text not null,
  owner_user_id uuid not null references public.staff_profiles (user_id),
  customer_name text not null check (length(customer_name) between 1 and 120),
  mobile text check (mobile ~ '^[6-9][0-9]{9}$'),
  email text check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  company_name text check (length(company_name) between 1 and 200),
  source_kind text check (source_kind in ('walk_in', 'phone', 'whatsapp', 'email', 'referral', 'repeat_customer', 'social', 'other')),
  source_note text check (length(source_note) between 1 and 200),
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text check (closed_reason in ('duplicate', 'lost', 'handled_elsewhere', 'other', 'no_activity')),
  closed_at timestamptz,
  closed_by uuid references public.staff_profiles (user_id),
  close_note text check (length(close_note) between 1 and 500),
  closed_due_on date,
  last_activity_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  created_via text not null check (created_via in ('quotation', 'itinerary')),
  request_id uuid not null,
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  unique (legal_entity_id, id),
  constraint referral_drafts_number_unique unique (legal_entity_id, draft_no),
  constraint referral_drafts_request_unique unique (created_by, request_id),
  constraint referral_drafts_reference_check check (reference = 'TD-' || draft_no::text),
  constraint referral_drafts_closed_complete check (
    (status = 'closed') = (closed_at is not null)
    and (status = 'closed') = (closed_reason is not null)
    and coalesce(closed_reason = 'no_activity', false) = (closed_due_on is not null)
    and (closed_by is null or coalesce(closed_reason <> 'no_activity', false))
    and (closed_reason is null or closed_reason = 'no_activity' or closed_by is not null)
    and (status = 'closed' or close_note is null))
);
create index referral_drafts_branch_idx on public.referral_drafts (legal_entity_id, branch_id);
create index referral_drafts_owner_idx on public.referral_drafts (owner_user_id);
create index referral_drafts_closed_by_idx on public.referral_drafts (closed_by) where closed_by is not null;
create index referral_drafts_open_activity_idx on public.referral_drafts (last_activity_at) where status = 'open';
create index referral_drafts_mobile_idx on public.referral_drafts (legal_entity_id, mobile) where mobile is not null;
comment on table public.referral_drafts is
  'Batch 3: a customer without a Bitrix record yet ("Draft for <name>", TD-n). Only the name is required. Editors only (owner with Sales in the branch, branch Manager, editors of an actively linked Deal or Lead); no Data API read. Never deleted; closes after 90 days without activity while the referral_drafts switch is on.';

create table public.referral_draft_links (
  id uuid primary key default gen_random_uuid(),
  referral_draft_id uuid not null,
  legal_entity_id uuid not null,
  target_kind text not null check (target_kind in ('lead', 'deal')),
  lead_id uuid references public.crm_leads (id),
  deal_id uuid,
  linked_by uuid not null references public.staff_profiles (user_id),
  linked_at timestamptz not null default now(),
  link_note text check (length(link_note) between 1 and 500),
  ended_by uuid references public.staff_profiles (user_id),
  ended_at timestamptz,
  end_reason text check (end_reason in ('wrong_link', 'duplicate', 'other')),
  end_note text check (length(end_note) between 10 and 500),
  foreign key (legal_entity_id, referral_draft_id) references public.referral_drafts (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  constraint referral_draft_links_target_check check (
    (target_kind = 'lead') = (lead_id is not null) and (target_kind = 'deal') = (deal_id is not null)),
  constraint referral_draft_links_end_complete check (
    (ended_at is null) = (ended_by is null) and (ended_at is null) = (end_reason is null)
    and (ended_at is null) = (end_note is null))
);
create unique index referral_draft_links_one_active on public.referral_draft_links (referral_draft_id, target_kind)
  where ended_at is null;
create index referral_draft_links_draft_idx on public.referral_draft_links (legal_entity_id, referral_draft_id);
create index referral_draft_links_deal_idx on public.referral_draft_links (deal_id) where deal_id is not null;
create index referral_draft_links_lead_idx on public.referral_draft_links (lead_id) where lead_id is not null;
create index referral_draft_links_linked_by_idx on public.referral_draft_links (linked_by);
create index referral_draft_links_ended_by_idx on public.referral_draft_links (ended_by) where ended_by is not null;
comment on table public.referral_draft_links is
  'Batch 3: explicit staff links of a referral draft to a Bitrix Lead or Deal (never by matching name, mobile or e-mail). Append-only history; a wrong link is ended with a reason, never deleted.';

-- Third subject kind on quotations and itinerary documents.
alter table public.quotations
  add column referral_draft_id uuid,
  add constraint quotations_referral_draft_fk foreign key (legal_entity_id, referral_draft_id)
    references public.referral_drafts (legal_entity_id, id),
  drop constraint quotations_subject_check,
  add constraint quotations_subject_check check (num_nonnulls(lead_id, deal_id, referral_draft_id) = 1),
  drop constraint quotations_link_lead_only,
  add constraint quotations_link_lead_only check (linked_deal_id is null or lead_id is not null or referral_draft_id is not null);
create index quotations_referral_draft_idx on public.quotations (referral_draft_id) where referral_draft_id is not null;

alter table public.itinerary_documents
  add column referral_draft_id uuid,
  add constraint itinerary_documents_referral_draft_fk foreign key (legal_entity_id, referral_draft_id)
    references public.referral_drafts (legal_entity_id, id),
  drop constraint itinerary_documents_subject_check,
  add constraint itinerary_documents_subject_check check (num_nonnulls(quotation_id, deal_id, referral_draft_id) = 1);
create index itinerary_documents_referral_draft_idx on public.itinerary_documents (referral_draft_id)
  where referral_draft_id is not null;

-- Guards: never deleted, identity immutable; links change only to end once.
create function authz.referral_drafts_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'referral drafts are never deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id
     or new.branch_id is distinct from old.branch_id or new.draft_no is distinct from old.draft_no
     or new.reference is distinct from old.reference or new.request_id is distinct from old.request_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.created_via is distinct from old.created_via then
    raise exception 'referral draft identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger referral_drafts_a_guard before update or delete on public.referral_drafts
  for each row execute function authz.referral_drafts_guard();

create function authz.referral_draft_links_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'referral draft links are never deleted' using errcode = '42501';
  end if;
  if old.ended_at is not null
     or new.id is distinct from old.id or new.referral_draft_id is distinct from old.referral_draft_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.target_kind is distinct from old.target_kind
     or new.lead_id is distinct from old.lead_id or new.deal_id is distinct from old.deal_id
     or new.linked_by is distinct from old.linked_by or new.linked_at is distinct from old.linked_at
     or new.link_note is distinct from old.link_note then
    raise exception 'a referral draft link only ends, once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger referral_draft_links_a_guard before update or delete on public.referral_draft_links
  for each row execute function authz.referral_draft_links_guard();

-- Echo-A L6: a document made on a referral draft is in the draft's entity and branch.
create function authz.itinerary_documents_referral_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.referral_draft_id is not null and not exists (
       select 1 from public.referral_drafts r
       where r.id = new.referral_draft_id and r.legal_entity_id = new.legal_entity_id and r.branch_id = new.branch_id) then
    raise exception 'itinerary referral draft must belong to the same entity and branch' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger itinerary_documents_b_referral_guard before insert on public.itinerary_documents
  for each row execute function authz.itinerary_documents_referral_guard();

create function authz.referral_refuse_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'referral drafts and links are never truncated' using errcode = '42501';
end;
$$;
create trigger referral_drafts_no_truncate before truncate on public.referral_drafts
  for each statement execute function authz.referral_refuse_truncate();
create trigger referral_draft_links_no_truncate before truncate on public.referral_draft_links
  for each statement execute function authz.referral_refuse_truncate();

do $$
declare
  t text;
begin
  foreach t in array array['referral_draft_counters', 'referral_drafts', 'referral_draft_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 3. Access, state and lock helpers (internal; no API grant)
-- ===========================================================================

-- Owner with an active Sales membership in the draft's branch, or that
-- branch's Manager; never a Purchase role holder in the entity.
create function authz.referral_draft_owner_or_manager(p_draft uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.referral_drafts r
    join public.memberships m on m.legal_entity_id = r.legal_entity_id and m.branch_id = r.branch_id
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where r.id = p_draft and m.user_id = (select auth.uid()) and m.status = 'active'
      and e.status = 'enabled' and b.status = 'enabled'
      and not authz.holds_role('purchase', r.legal_entity_id)
      and ((m.role_code = 'sales' and r.owner_user_id = (select auth.uid())) or m.role_code = 'manager'))
$$;

create function authz.referral_draft_is_manager(p_draft uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.referral_drafts r
    join public.memberships m on m.legal_entity_id = r.legal_entity_id and m.branch_id = r.branch_id
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where r.id = p_draft and m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'manager'
      and e.status = 'enabled' and b.status = 'enabled'
      and not authz.holds_role('purchase', r.legal_entity_id))
$$;

-- B.3: editor equals reader. Owner / Manager, or the editors of an ACTIVE
-- Deal or Lead link (ending the link removes their access at once).
create function authz.referral_draft_can_edit(p_draft uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and coalesce((
    select not authz.holds_role('purchase', r.legal_entity_id)
       and (authz.referral_draft_owner_or_manager(r.id)
            or exists (select 1 from public.referral_draft_links k
                       where k.referral_draft_id = r.id and k.ended_at is null and k.deal_id is not null
                         and authz.can_edit_booking_draft(k.deal_id))
            or exists (select 1 from public.referral_draft_links k
                       where k.referral_draft_id = r.id and k.ended_at is null and k.lead_id is not null
                         and authz.quotation_lead_editor(k.lead_id)))
    from public.referral_drafts r where r.id = p_draft), false)
$$;

-- Who may start a draft in a branch: active Sales or Manager there, no Purchase.
create function authz.referral_branch_creator(p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.memberships m
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.branch_id = p_branch and m.user_id = (select auth.uid()) and m.status = 'active'
      and m.role_code in ('sales', 'manager') and e.status = 'enabled' and b.status = 'enabled'
      and not authz.holds_role('purchase', m.legal_entity_id))
$$;

-- A quotation of the draft is bound to a Deal or converted: the draft belongs
-- to the booking now and never closes automatically.
create function authz.referral_draft_bound(p_draft uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.quotations q
                 where q.referral_draft_id = p_draft and (q.linked_deal_id is not null or q.converted_at is not null))
$$;

-- F.3.2: the one cutoff (IST calendar day). A draft whose last activity was on
-- 1 March (IST) stays open through 30 May and is closed from 31 May 00:00 IST.
create function authz.referral_due_on(p_last_activity timestamptz) returns date
language sql stable security definer set search_path = '' as $$
  select ((greatest(p_last_activity, (select s.referral_auto_close_resumed_at from public.workflow_settings s where s.id))
           at time zone 'Asia/Kolkata')::date + 91)
$$;

create function authz.referral_close_due_on(p_draft uuid) returns date
language sql stable security definer set search_path = '' as $$
  select authz.referral_due_on(r.last_activity_at) from public.referral_drafts r where r.id = p_draft
$$;

-- Due for the automatic closure (only while the switch is on).
create function authz.referral_draft_due(p_draft uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.referral_drafts_enabled() and exists (
    select 1 from public.referral_drafts r
    where r.id = p_draft and r.status = 'open'
      and authz.finance_today() >= authz.referral_due_on(r.last_activity_at))
    and not authz.referral_draft_bound(p_draft)
$$;

-- Effective state on every read (reads never write):
-- {status, closedReason, closedAt, autoClose: {state, dueOn}}.
create function authz.referral_draft_state(p_draft uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.referral_drafts;
  v_due date;
begin
  select * into r from public.referral_drafts d where d.id = p_draft;
  if r.id is null then
    return null;
  end if;
  if r.status = 'closed' then
    return jsonb_build_object('status', 'closed', 'closedReason', r.closed_reason, 'closedAt', r.closed_at,
      'autoClose', jsonb_build_object('state', case when r.closed_reason = 'no_activity' then 'closed' else 'none' end,
                                      'dueOn', to_char(r.closed_due_on, 'YYYY-MM-DD')));
  end if;
  if authz.referral_draft_bound(r.id) then
    return jsonb_build_object('status', 'open', 'closedReason', null, 'closedAt', null,
      'autoClose', jsonb_build_object('state', 'none', 'dueOn', null));
  end if;
  if not authz.referral_drafts_enabled() then
    return jsonb_build_object('status', 'open', 'closedReason', null, 'closedAt', null,
      'autoClose', jsonb_build_object('state', 'paused', 'dueOn', null));
  end if;
  v_due := authz.referral_due_on(r.last_activity_at);
  if authz.finance_today() >= v_due then
    return jsonb_build_object('status', 'closed', 'closedReason', 'no_activity', 'closedAt', null,
      'autoClose', jsonb_build_object('state', 'closed', 'dueOn', to_char(v_due, 'YYYY-MM-DD')));
  end if;
  return jsonb_build_object('status', 'open', 'closedReason', null, 'closedAt', null,
    'autoClose', jsonb_build_object('state', 'scheduled', 'dueOn', to_char(v_due, 'YYYY-MM-DD')));
end;
$$;

-- Effectively closed (stored, or due while the switch is on).
create function authz.referral_draft_closed(p_draft uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.referral_drafts r where r.id = p_draft and r.status = 'closed')
      or authz.referral_draft_due(p_draft)
$$;

-- Owner display name rule (DEC-52): referral owner only for the owner or a
-- branch Manager of the draft.
create function authz.referral_owner_name(p_draft uuid) returns text
language sql stable security definer set search_path = '' as $$
  select p.display_name from public.referral_drafts r join public.staff_profiles p on p.user_id = r.owner_user_id
  where r.id = p_draft and (r.owner_user_id = (select auth.uid()) or authz.referral_draft_is_manager(r.id))
$$;

-- Mercury F1 (via Terra): the draft's active link for list rows, reference
-- only ({kind, reference}; the Deal link before the Lead link; null when none).
create function authz.referral_active_link(p_draft uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('kind', 'deal', 'reference', d.reference) from public.referral_draft_links k
     join public.deals d on d.id = k.deal_id where k.referral_draft_id = p_draft and k.ended_at is null),
    (select jsonb_build_object('kind', 'lead', 'reference', l.reference) from public.referral_draft_links k
     join public.crm_leads l on l.id = k.lead_id where k.referral_draft_id = p_draft and k.ended_at is null))
$$;

-- The draft summary carried by quotation_get / itinerary_document_get.
create function authz.referral_draft_brief(p_draft uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('referralDraftId', r.id, 'reference', r.reference,
      'linked', exists (select 1 from public.referral_draft_links k where k.referral_draft_id = r.id and k.ended_at is null),
      'bound', authz.referral_draft_bound(r.id),
      'activeDealId', (select k.deal_id from public.referral_draft_links k
                       where k.referral_draft_id = r.id and k.ended_at is null and k.deal_id is not null),
      'activeLeadId', (select k.lead_id from public.referral_draft_links k
                       where k.referral_draft_id = r.id and k.ended_at is null and k.lead_id is not null),
      -- Echo-B M5: the draft owner (name only for the owner or a branch Manager, DEC-52 rule).
      'ownerIsYou', r.owner_user_id = (select auth.uid()), 'ownerName', authz.referral_owner_name(r.id))
    || authz.referral_draft_state(r.id)
    || jsonb_build_object('canReopen', authz.referral_draft_owner_or_manager(r.id)
                                       and authz.referral_draft_state(r.id) ->> 'status' = 'closed')
  from public.referral_drafts r where r.id = p_draft
$$;

-- F.3.3: every write on a referral subject. The CALLER has already checked
-- authorization (F.6 N2). Locks the draft row first and refuses draft_closed
-- before anything is written. Echo-A L2: activity moves only when the command
-- really writes: the draft is remembered for THIS statement and the audit row
-- every write command records moves last_activity_at (trigger below); a
-- no-op replay writes no audit row and so counts as nothing.
create function authz.referral_draft_lock_write(p_draft uuid) returns public.referral_drafts
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.referral_drafts%rowtype;
begin
  select * into r from public.referral_drafts d where d.id = p_draft for update;
  if r.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if r.status = 'closed' or authz.referral_draft_due(r.id) then
    raise exception 'draft_closed' using errcode = '55000';
  end if;
  perform set_config('tripnavigate.referral_activity', r.id::text || '|' || statement_timestamp()::text, true);
  return r;
end;
$$;

-- Echo-A L2: a write command's audit row is the activity (B.9: any successful
-- write). Only for the draft locked by referral_draft_lock_write in the same
-- statement; persisted expiry is a side effect, not activity. The draft row is
-- already locked by this transaction, so the lock order is unchanged.
create function authz.referral_activity_from_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v text := current_setting('tripnavigate.referral_activity', true);
begin
  if v is null or v = '' or new.action = 'quotation.expired'
     or split_part(v, '|', 2) is distinct from statement_timestamp()::text then
    return null;
  end if;
  update public.referral_drafts d set last_activity_at = now()
  where d.id = split_part(v, '|', 1)::uuid and d.last_activity_at is distinct from now();
  return null;
end;
$$;
create trigger audit_events_referral_activity after insert on public.audit_events
  for each row execute function authz.referral_activity_from_audit();

-- Persists the automatic closure of a due draft the caller holds locked (the
-- job, reopen and manual close only). One audit row; returns dueOn.
create function authz.referral_draft_persist_auto_close(p_draft uuid) returns date
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.referral_drafts%rowtype;
  v_due date;
begin
  select * into r from public.referral_drafts d where d.id = p_draft;
  v_due := authz.referral_due_on(r.last_activity_at);
  update public.referral_drafts d
  set status = 'closed', closed_reason = 'no_activity', closed_at = now(), closed_by = null, close_note = null,
      closed_due_on = v_due, row_version = d.row_version + 1, updated_at = now()
  where d.id = r.id;
  perform authz.write_audit('referral.draft_closed', r.legal_entity_id, r.branch_id, 'referral_draft', r.id, null,
    jsonb_build_object('automatic', true, 'reason', 'no_activity', 'dueOn', to_char(v_due, 'YYYY-MM-DD'),
      'lastActivityAt', r.last_activity_at));
  return v_due;
end;
$$;

-- The Bitrix record a quotation reads its suggestions from: its own Deal or
-- Lead; for a referral quotation the bound Deal, else the active Deal link,
-- else the active Lead link; {kind: null, id: null} when unlinked.
create function authz.quotation_bitrix_subject(p_quotation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when q.deal_id is not null then jsonb_build_object('kind', 'deal', 'id', q.deal_id)
    when q.lead_id is not null then jsonb_build_object('kind', 'lead', 'id', q.lead_id)
    when q.linked_deal_id is not null then jsonb_build_object('kind', 'deal', 'id', q.linked_deal_id)
    else coalesce(
      (select jsonb_build_object('kind', 'deal', 'id', k.deal_id) from public.referral_draft_links k
       where k.referral_draft_id = q.referral_draft_id and k.ended_at is null and k.deal_id is not null),
      (select jsonb_build_object('kind', 'lead', 'id', k.lead_id) from public.referral_draft_links k
       where k.referral_draft_id = q.referral_draft_id and k.ended_at is null and k.lead_id is not null),
      jsonb_build_object('kind', null, 'id', null)) end
  from public.quotations q where q.id = p_quotation
$$;

-- Referral customer input (B.2 formats). Returns the refused keys.
create function authz.referral_customer_bad(p jsonb, p_create boolean) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v_bad text[];
  v text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return array['customer'];
  end if;
  v_bad := authz.b11_unknown_keys(p, array['customerName', 'mobile', 'email', 'companyName', 'sourceKind', 'sourceNote']);
  if (p_create or p ? 'customerName') and not authz.sf_text_ok(p -> 'customerName', 120, true) then
    v_bad := v_bad || 'customerName'::text;
  end if;
  v := authz.b11_text(p -> 'mobile');
  if (p ? 'mobile' and jsonb_typeof(p -> 'mobile') not in ('string', 'null')) or (v is not null and v !~ '^[6-9][0-9]{9}$') then
    v_bad := v_bad || 'mobile'::text;
  end if;
  v := authz.b11_text(p -> 'email');
  if (p ? 'email' and jsonb_typeof(p -> 'email') not in ('string', 'null'))
     or (v is not null and (length(v) > 254 or v !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) then
    v_bad := v_bad || 'email'::text;
  end if;
  if not authz.sf_text_ok(p -> 'companyName', 200, false) then v_bad := v_bad || 'companyName'::text; end if;
  v := authz.b11_text(p -> 'sourceKind');
  if (p ? 'sourceKind' and jsonb_typeof(p -> 'sourceKind') not in ('string', 'null'))
     or (v is not null and v not in ('walk_in', 'phone', 'whatsapp', 'email', 'referral', 'repeat_customer', 'social', 'other')) then
    v_bad := v_bad || 'sourceKind'::text;
  end if;
  if not authz.sf_text_ok(p -> 'sourceNote', 200, false) then v_bad := v_bad || 'sourceNote'::text; end if;
  return v_bad;
end;
$$;

-- Optional free-text note: null/blank = none; else 1..p_max characters.
create function authz.referral_note(p_note text, p_min integer, p_max integer, p_hint text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
begin
  if v is null then
    if p_min > 0 then
      raise exception 'invalid_input' using errcode = '22023', hint = p_hint;
    end if;
    return null;
  end if;
  if char_length(v) < greatest(p_min, 1) or char_length(v) > p_max or v ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023', hint = p_hint;
  end if;
  return v;
end;
$$;


-- ===========================================================================
-- 4. Replaced bodies, part 1 (short; copied by hand from the latest definitions)
-- ===========================================================================

-- authz.quotations_guard (replaces 20261120000200_b12_quotations.sql:329). Batch 3:
-- referral_draft_id is immutable; a referral quotation is in its draft's entity and branch.
create or replace function authz.quotations_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quotations are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.branch_id is distinct from old.branch_id or new.quote_no is distinct from old.quote_no
       or new.reference is distinct from old.reference or new.lead_id is distinct from old.lead_id
       or new.deal_id is distinct from old.deal_id or new.request_id is distinct from old.request_id
       or new.referral_draft_id is distinct from old.referral_draft_id  -- Batch 3
       or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
       or (old.linked_deal_id is not null and new.linked_deal_id is distinct from old.linked_deal_id)
       or (old.converted_at is not null and new.converted_at is distinct from old.converted_at)) then
    raise exception 'quotation identity columns are immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.lead_id is not null and not exists (
       select 1 from public.crm_leads l
       where l.id = new.lead_id and l.legal_entity_id = new.legal_entity_id and l.branch_id = new.branch_id) then
    raise exception 'quotation lead must belong to the same entity and branch' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.deal_id is not null and not exists (
       select 1 from public.deals d where d.id = new.deal_id and d.branch_id = new.branch_id) then
    raise exception 'quotation deal must belong to the same branch' using errcode = '42501';
  end if;
  -- Batch 3
  if tg_op = 'INSERT' and new.referral_draft_id is not null and not exists (
       select 1 from public.referral_drafts r
       where r.id = new.referral_draft_id and r.legal_entity_id = new.legal_entity_id and r.branch_id = new.branch_id) then
    raise exception 'quotation referral draft must belong to the same entity and branch' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- authz.quotation_can_edit (replaces 20261120000200_b12_quotations.sql:569). Batch 3:
-- referral quotations follow the draft (B.3), plus the bound Deal's editors.
create or replace function authz.quotation_can_edit(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when q.deal_id is not null then authz.can_edit_booking_draft(q.deal_id)
                when q.referral_draft_id is not null then authz.referral_draft_can_edit(q.referral_draft_id)  -- Batch 3
                     or (q.linked_deal_id is not null and authz.can_edit_booking_draft(q.linked_deal_id))
                else authz.quotation_lead_editor(q.lead_id)
                     or (q.linked_deal_id is not null and authz.can_edit_booking_draft(q.linked_deal_id)) end
    from public.quotations q where q.id = p_quotation), false)
$$;

-- authz.quotation_money_can_read (replaces 20261120000300_b12_quotation_money.sql:268).
-- Batch 3 (M3): referral quotations as Lead quotations: the draft OWNER with
-- own-scope deal.read_commercial, entity scope or a branch grant of it, and
-- after binding the bound Deal's commercial readers. Manager oversight alone
-- gives no price access; never Purchase; never Super Admin by role (no edit right).
create or replace function authz.quotation_money_can_read(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select authz.quotation_can_edit(q.id)
       and not authz.holds_role('purchase', q.legal_entity_id)
       and (case when q.deal_id is not null then authz.can_read_deal_commercial(q.deal_id)
                 when q.referral_draft_id is not null then  -- Batch 3
                   (r.owner_user_id = (select auth.uid())
                      and authz.has_role_permission('deal.read_commercial', q.legal_entity_id, 'own'))
                   or authz.has_role_permission('deal.read_commercial', q.legal_entity_id, 'entity')
                   or authz.has_grant('deal.read_commercial', q.legal_entity_id, q.branch_id)
                 else (l.owner_user_id = (select auth.uid())
                         and authz.has_role_permission('deal.read_commercial', q.legal_entity_id, 'own'))
                   or authz.has_role_permission('deal.read_commercial', q.legal_entity_id, 'entity')
                   or authz.has_grant('deal.read_commercial', q.legal_entity_id, q.branch_id) end
            or (q.linked_deal_id is not null and authz.can_read_deal_commercial(q.linked_deal_id)))
    from public.quotations q
    left join public.crm_leads l on l.id = q.lead_id
    left join public.referral_drafts r on r.id = q.referral_draft_id
    where q.id = p_quotation), false)
$$;

-- authz.itinerary_can_edit (replaces 20261120000500_b12_itineraries.sql:351). Batch 3:
-- documents made straight on a referral draft follow the draft.
create or replace function authz.itinerary_can_edit(p_document uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when d.quotation_id is not null then authz.quotation_can_edit(d.quotation_id)
                when d.referral_draft_id is not null then authz.referral_draft_can_edit(d.referral_draft_id)  -- Batch 3
                else authz.can_edit_booking_draft(d.deal_id) end
    from public.itinerary_documents d where d.id = p_document), false)
$$;

-- authz.itinerary_basis (replaces 20261120000500_b12_itineraries.sql:488). Batch 3
-- (DA-80 as narrowed by the lead after Echo-A M2): a document made straight on
-- a referral draft compares only with the draft's OWN accepted quotation, else
-- with nothing (never the linked Deal's booking or the Deal's quotation; once
-- linked, Deal itineraries are made on the Deal).
create or replace function authz.itinerary_basis(p_document uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents;
  v_qv public.quotation_versions;
  v_bv public.booking_versions;
  v_quotation uuid;
begin
  select * into v_doc from public.itinerary_documents d where d.id = p_document;
  if v_doc.id is null then
    return null;
  end if;
  v_quotation := v_doc.quotation_id;
  -- Batch 3
  if v_doc.referral_draft_id is not null then
    select q.id into v_quotation from public.quotations q
    where q.referral_draft_id = v_doc.referral_draft_id and q.accepted_version_id is not null
    order by q.created_at, q.id limit 1;
  end if;
  if v_quotation is null then
    select q.id into v_quotation from public.quotations q
    where q.accepted_version_id is not null and (q.deal_id = v_doc.deal_id or q.linked_deal_id = v_doc.deal_id)
    order by q.created_at limit 1;
  end if;
  if v_quotation is not null then
    select * into v_qv from public.quotation_versions v where v.quotation_id = v_quotation and v.status = 'accepted';
    if v_qv.id is null then
      select * into v_qv from public.quotation_versions v
      where v.quotation_id = v_quotation and v.status = 'sent' and authz.quotation_status(v) = 'sent';
    end if;
    if v_qv.id is null and v_doc.quotation_id is not null then
      select * into v_qv from public.quotation_versions v where v.quotation_id = v_quotation and v.status in ('draft', 'ready');
    end if;
    if v_qv.id is not null then
      return jsonb_build_object('kind', 'quotation_version', 'id', v_qv.id,
        'hash', coalesce(v_qv.content_hash, authz.quotation_content_hash(v_qv.id)));
    end if;
  end if;
  if v_doc.deal_id is not null then
    v_bv := authz.deal_current_version(v_doc.deal_id);
    if v_bv.id is not null then
      return jsonb_build_object('kind', 'booking_version', 'id', v_bv.id, 'hash', v_bv.content_hash);
    end if;
  end if;
  return jsonb_build_object('kind', 'none', 'id', null, 'hash', repeat('0', 64));
end;
$$;

-- authz.itinerary_money_reader (replaces 20261120000500_b12_itineraries.sql:532).
-- Batch 3 (DEC-48, M3): a document on a referral draft prints prices only from
-- its basis, for that basis's money readers.
create or replace function authz.itinerary_money_reader(p_document uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when d.quotation_id is not null then authz.quotation_money_can_read(d.quotation_id)
                when d.referral_draft_id is not null then (  -- Batch 3
                  select case b.j ->> 'kind'
                    when 'quotation_version' then authz.quotation_money_can_read(
                      (select v.quotation_id from public.quotation_versions v where v.id = (b.j ->> 'id')::uuid))
                    when 'booking_version' then authz.can_read_deal_commercial(
                      (select bv.deal_id from public.booking_versions bv where bv.id = (b.j ->> 'id')::uuid))
                    else false end
                  from (select authz.itinerary_basis(d.id) as j) b)
                else authz.can_read_deal_commercial(d.deal_id) end
    from public.itinerary_documents d where d.id = p_document), false)
$$;

-- public.quotation_link_deal (replaces 20261120000200_b12_quotations.sql:1611). Batch 3:
-- binds an accepted referral quotation to the draft's ACTIVELY linked Deal
-- (deal_not_linked_to_draft otherwise); lock order draft -> quotation -> Deal.
-- Binding never converts; conversion stays quotation_convert_to_booking.
create or replace function public.quotation_link_deal(p_quotation_id uuid, p_deal_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_q public.quotations%rowtype;
  v_lead public.crm_leads%rowtype;
  v_deal public.deals%rowtype;
  v_draft uuid;  -- Batch 3
begin
  -- Batch 3 (F.3.3, F.6 N2): authorization first, then the draft row.
  select q.referral_draft_id into v_draft from public.quotations q where q.id = p_quotation_id;
  if v_draft is not null then
    if not authz.quotation_can_edit(p_quotation_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    perform authz.referral_draft_lock_write(v_draft);
  end if;
  select * into v_q from public.quotations q where q.id = p_quotation_id for update;
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_q.lead_id is null and v_q.referral_draft_id is null then  -- Batch 3
    raise exception 'invalid_input' using errcode = '22023', hint = 'quotation';
  end if;
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_q.linked_deal_id is not null then
    if v_q.linked_deal_id = p_deal_id then
      return jsonb_build_object('quotationId', v_q.id, 'linkedDealId', v_q.linked_deal_id, 'rowVersion', v_q.row_version);
    end if;
    -- A link never changes.
    raise exception 'quotation_already_linked' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_q.row_version);
  if v_q.accepted_version_id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- Batch 3 (B.4): the referral draft must be linked to this very Deal.
  if v_q.referral_draft_id is not null and not exists (
       select 1 from public.referral_draft_links k
       where k.referral_draft_id = v_q.referral_draft_id and k.ended_at is null and k.deal_id = p_deal_id) then
    raise exception 'deal_not_linked_to_draft' using errcode = '55000';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if v_q.lead_id is not null then  -- Batch 3: a referral draft's link was checked when it was made
    select * into v_lead from public.crm_leads l where l.id = v_q.lead_id;
    if v_deal.source_lead_id is null or v_deal.source_lead_id is distinct from v_lead.source_lead_id
       or v_deal.source_portal is distinct from v_lead.source_portal or v_deal.legal_entity_id <> v_q.legal_entity_id then
      raise exception 'deal_not_from_lead' using errcode = '22023';
    end if;
  end if;
  if v_deal.branch_id <> v_q.branch_id then
    raise exception 'branch_mismatch' using errcode = '22023';
  end if;
  -- Review E2-4: the Deal already has an accepted quotation of its own or a linked one.
  if exists (select 1 from public.quotations o
             where o.id <> v_q.id and (o.linked_deal_id = p_deal_id or (o.deal_id = p_deal_id and o.accepted_version_id is not null))) then
    raise exception 'deal_already_linked' using errcode = '55000';
  end if;
  update public.quotations q
  set linked_deal_id = p_deal_id, linked_by = (select auth.uid()), linked_at = now(), row_version = q.row_version + 1, updated_at = now()
  where q.id = v_q.id returning * into v_q;
  perform authz.write_audit('quotation.deal_linked', v_q.legal_entity_id, v_q.branch_id, 'quotation', v_q.id, null,
    jsonb_build_object('dealId', p_deal_id, 'leadId', v_q.lead_id)
    || case when v_q.referral_draft_id is not null then jsonb_build_object('referralDraftId', v_q.referral_draft_id)
            else '{}'::jsonb end);  -- Batch 3
  return jsonb_build_object('quotationId', v_q.id, 'linkedDealId', p_deal_id, 'rowVersion', v_q.row_version);
end;
$$;

-- ===========================================================================
-- 8. Replaced bodies, part 2 (generated mechanically from the LATEST definitions;
--    every changed line is marked "Batch 3"). Source file:line in each heading.
-- ===========================================================================

-- authz.lock_quotation_draft (replaces 20261120000200_b12_quotations.sql:666). Batch 3: referral draft locked first; draft_closed before any write.
create or replace function authz.lock_quotation_draft(p_version_id uuid) returns public.quotation_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_draft uuid;  -- Batch 3
begin
  -- Batch 3 (F.3.3, F.6 N2): a referral quotation checks authorization first
  -- (unlocked read), then locks the draft row and refuses draft_closed before
  -- anything is written (lock order draft -> quotation -> version -> Deal).
  select q.referral_draft_id into v_draft from public.quotations q
  where q.id = (select v.quotation_id from public.quotation_versions v where v.id = p_version_id);
  if v_draft is not null then
    if not authz.quotation_can_edit((select v.quotation_id from public.quotation_versions v where v.id = p_version_id)) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    perform authz.referral_draft_lock_write(v_draft);
  end if;
  select * into v_q from public.quotations q
  where q.id = (select v.quotation_id from public.quotation_versions v where v.id = p_version_id) for update;
  perform authz.refuse_removed_deal(coalesce(v_q.deal_id, v_q.linked_deal_id));
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.quotation_expire_due(v_q.id);
  select * into v_ver from public.quotation_versions v where v.id = p_version_id for update;
  if v_q.converted_at is not null then
    raise exception 'quotation_converted' using errcode = '55000';
  end if;
  if v_ver.status not in ('draft', 'ready') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_ver.status = 'ready' then
    update public.quotation_versions v set status = 'draft', content_hash = null where v.id = v_ver.id
    returning * into v_ver;
  end if;
  return v_ver;
end;
$$;

-- authz.lock_quotation_version (replaces 20261120000200_b12_quotations.sql:835). Batch 3: referral draft locked first; draft_closed before any write.
create or replace function authz.lock_quotation_version(p_version_id uuid) returns public.quotation_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_q public.quotations%rowtype;
  v_ver public.quotation_versions%rowtype;
  v_draft uuid;  -- Batch 3
begin
  -- Batch 3 (F.3.3, F.6 N2): a referral quotation checks authorization first
  -- (unlocked read), then locks the draft row and refuses draft_closed before
  -- anything is written (lock order draft -> quotation -> version -> Deal).
  select q.referral_draft_id into v_draft from public.quotations q
  where q.id = (select v.quotation_id from public.quotation_versions v where v.id = p_version_id);
  if v_draft is not null then
    if not authz.quotation_can_edit((select v.quotation_id from public.quotation_versions v where v.id = p_version_id)) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    perform authz.referral_draft_lock_write(v_draft);
  end if;
  select * into v_q from public.quotations q
  where q.id = (select v.quotation_id from public.quotation_versions v where v.id = p_version_id) for update;
  perform authz.refuse_removed_deal(coalesce(v_q.deal_id, v_q.linked_deal_id));
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.quotation_expire_due(v_q.id);
  select * into v_ver from public.quotation_versions v where v.id = p_version_id for update;
  return v_ver;
end;
$$;

-- authz.lock_itinerary_document (replaces 20261120000500_b12_itineraries.sql:561). Batch 3: documents on a referral draft or a referral quotation lock the draft first.
create or replace function authz.lock_itinerary_document(p_document uuid) returns public.itinerary_documents
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents%rowtype;
  v_draft uuid;  -- Batch 3
begin
  -- Batch 3 (F.3.3, F.6 N2): authorization first, then the draft row.
  select coalesce(d.referral_draft_id, (select q.referral_draft_id from public.quotations q where q.id = d.quotation_id))
  into v_draft from public.itinerary_documents d where d.id = p_document;
  if v_draft is not null then
    if not authz.itinerary_can_edit(p_document) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    perform authz.referral_draft_lock_write(v_draft);
  end if;
  select * into v_doc from public.itinerary_documents d where d.id = p_document for share;
  perform authz.refuse_removed_deal(authz.itinerary_deal(v_doc.id));
  if v_doc.id is null or not authz.itinerary_can_edit(v_doc.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v_doc;
end;
$$;

-- public.quotation_new_version (replaces 20261122000100_prefill_auto_fill.sql:1649). Batch 3: referral draft locked first.
create or replace function public.quotation_new_version(p_quotation_id uuid, p_base_version_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_q public.quotations%rowtype;
  v_base public.quotation_versions%rowtype;
  v_open public.quotation_versions%rowtype;
  v_new public.quotation_versions%rowtype;
  v_draft uuid;  -- Batch 3
begin
  -- Batch 3 (F.3.3, F.6 N2): authorization first, then the draft row.
  select q.referral_draft_id into v_draft from public.quotations q where q.id = p_quotation_id;
  if v_draft is not null then
    if not authz.quotation_can_edit(p_quotation_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    perform authz.referral_draft_lock_write(v_draft);
  end if;
  select * into v_q from public.quotations q where q.id = p_quotation_id for update;
  perform authz.refuse_removed_deal(coalesce(v_q.deal_id, v_q.linked_deal_id));
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  perform authz.quotation_expire_due(v_q.id);
  if v_q.converted_at is not null then
    raise exception 'quotation_converted' using errcode = '55000';
  end if;
  select * into v_open from public.quotation_versions v where v.quotation_id = v_q.id and v.status in ('draft', 'ready');
  if v_open.id is not null then
    return jsonb_build_object('versionId', v_open.id, 'versionNo', v_open.version_no, 'rowVersion', v_open.row_version,
      'created', false);
  end if;
  select * into v_base from public.quotation_versions v where v.id = p_base_version_id and v.quotation_id = v_q.id;
  if v_base.id is null or v_base.status = 'discarded' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'baseVersionId';
  end if;
  insert into public.quotation_versions (quotation_id, legal_entity_id, version_no, based_on_version_id, trip_destination,
    trip_scope, trip_start, trip_end, adults, children_with_bed, children_no_bed, infants, pax_remarks, requirements_note,
    content, created_by, updated_by)
  select v_q.id, v_q.legal_entity_id, (select max(x.version_no) + 1 from public.quotation_versions x where x.quotation_id = v_q.id),
    v_base.id, v_base.trip_destination, v_base.trip_scope, v_base.trip_start, v_base.trip_end, v_base.adults,
    v_base.children_with_bed, v_base.children_no_bed, v_base.infants, v_base.pax_remarks, v_base.requirements_note,
    v_base.content, (select auth.uid()), (select auth.uid())
  returning * into v_new;
  insert into public.quotation_version_tiers (quotation_version_id, legal_entity_id, tier_key, label)
  select v_new.id, t.legal_entity_id, t.tier_key, t.label from public.quotation_version_tiers t where t.quotation_version_id = v_base.id;
  insert into public.quotation_version_items (quotation_version_id, legal_entity_id, item_no, service_type, tier_key, facts)
  select v_new.id, i.legal_entity_id, i.item_no, i.service_type, i.tier_key, i.facts
  from public.quotation_version_items i where i.quotation_version_id = v_base.id;
  insert into public.quotation_version_contacts (quotation_version_id, legal_entity_id, contact_name, mobile, email, company_name,
    booking_for, updated_by)
  select v_new.id, c.legal_entity_id, c.contact_name, c.mobile, c.email, c.company_name, c.booking_for, (select auth.uid())
  from public.quotation_version_contacts c where c.quotation_version_id = v_base.id;
  perform authz.quotation_copy_lines(v_base.id, v_new.id);
  -- Batch 2 (F.1.1 Copies): the new version inherits the base version's
  -- value-free history; the inserts above already recorded every non-empty
  -- copied field as a staff write. Latest events win.
  insert into public.prefill_field_history as h (target_kind, target_id, field_code, legal_entity_id, first_staff_write_at,
    last_staff_write_at, last_staff_write_by, cleared_at, cleared_by)
  select 'quotation_version', v_new.id, b.field_code, b.legal_entity_id, b.first_staff_write_at, b.last_staff_write_at,
    b.last_staff_write_by, b.cleared_at, b.cleared_by
  from public.prefill_field_history b where b.target_kind = 'quotation_version' and b.target_id = v_base.id
  on conflict (target_kind, target_id, field_code) do update
    set first_staff_write_at = least(h.first_staff_write_at, excluded.first_staff_write_at),
        last_staff_write_by = case when excluded.last_staff_write_at > coalesce(h.last_staff_write_at, '-infinity'::timestamptz)
                                   then excluded.last_staff_write_by else h.last_staff_write_by end,
        last_staff_write_at = greatest(h.last_staff_write_at, excluded.last_staff_write_at),
        cleared_by = case when excluded.cleared_at > coalesce(h.cleared_at, '-infinity'::timestamptz)
                          then excluded.cleared_by else h.cleared_by end,
        cleared_at = greatest(h.cleared_at, excluded.cleared_at);
  perform authz.write_audit('quotation.version_opened', v_q.legal_entity_id, v_q.branch_id, 'quotation_version', v_new.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionNo', v_new.version_no, 'basedOnVersionId', v_base.id));
  return jsonb_build_object('versionId', v_new.id, 'versionNo', v_new.version_no, 'rowVersion', v_new.row_version, 'created', true);
end;
$$;

-- public.quotation_create (replaces 20261122000100_prefill_auto_fill.sql:1570). Batch 3: subject 'referral' (another quotation on an existing draft; no creation fill).
create or replace function public.quotation_create(p_subject_kind text, p_subject_id uuid, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_branch uuid;
  v_owner uuid;
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_existing public.quotations%rowtype;
  v_no integer;
  v_q public.quotations%rowtype;
  v_ver public.quotation_versions%rowtype;
  v_fill jsonb;  -- Batch 2
  v_draft public.referral_drafts%rowtype;  -- Batch 3
begin
  if p_subject_kind is null or p_subject_kind not in ('lead', 'deal', 'referral') or p_subject_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'subjectKind';
  end if;
  if p_subject_kind = 'deal' then
    perform authz.refuse_removed_deal(p_subject_id);
    if not authz.can_edit_booking_draft(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if authz.deal_not_active(p_subject_id) then
      raise exception 'deal_not_active' using errcode = '55000';
    end if;
    select d.legal_entity_id, d.branch_id, d.owner_user_id into v_entity, v_branch, v_owner
    from public.deals d where d.id = p_subject_id;
  elsif p_subject_kind = 'referral' then
    -- Batch 3: authorization first, then the draft row (draft_closed). Works
    -- while the switch is off (DEC-54).
    if not authz.referral_draft_can_edit(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_draft := authz.referral_draft_lock_write(p_subject_id);
    v_entity := v_draft.legal_entity_id;
    v_branch := v_draft.branch_id;
    v_owner := v_draft.owner_user_id;
  else
    if not authz.quotation_lead_editor(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select l.legal_entity_id, l.branch_id, l.owner_user_id into v_entity, v_branch, v_owner
    from public.crm_leads l where l.id = p_subject_id;
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if length(v_title) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'title';
  end if;

  select * into v_existing from public.quotations q where q.created_by = (select auth.uid()) and q.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.title is distinct from v_title
       or (p_subject_kind = 'deal' and v_existing.deal_id is distinct from p_subject_id)
       or (p_subject_kind = 'lead' and v_existing.lead_id is distinct from p_subject_id)
       or (p_subject_kind = 'referral' and v_existing.referral_draft_id is distinct from p_subject_id) then  -- Batch 3
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    select * into v_ver from public.quotation_versions v where v.quotation_id = v_existing.id and v.version_no = 1;
    return jsonb_build_object('quotationId', v_existing.id, 'reference', v_existing.reference, 'versionId', v_ver.id,
      'versionNo', 1, 'rowVersion', v_ver.row_version, 'created', false,
      'autoFill', 'existing_draft', 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);  -- Batch 2: a replay fills nothing
  end if;

  insert into public.quotation_counters as c (legal_entity_id, last_no) values (v_entity, 1)
  on conflict (legal_entity_id) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.quotations (legal_entity_id, branch_id, quote_no, reference, lead_id, deal_id, referral_draft_id, title,
    owner_user_id, request_id, created_by)
  values (v_entity, v_branch, v_no, 'TQ-' || v_no::text,
    case when p_subject_kind = 'lead' then p_subject_id end, case when p_subject_kind = 'deal' then p_subject_id end,
    case when p_subject_kind = 'referral' then p_subject_id end,  -- Batch 3
    v_title, v_owner, p_request_id, (select auth.uid()))
  returning * into v_q;
  insert into public.quotation_versions (quotation_id, legal_entity_id, version_no, created_by, updated_by)
  values (v_q.id, v_entity, 1, (select auth.uid()), (select auth.uid()))
  returning * into v_ver;
  insert into public.quotation_version_tiers (quotation_version_id, legal_entity_id, tier_key) values (v_ver.id, v_entity, 'quoted');

  perform authz.write_audit('quotation.created', v_entity, v_branch, 'quotation', v_q.id, null,
    jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id, 'reference', v_q.reference, 'versionId', v_ver.id));
  -- Batch 2 (C1): the creation fill of version 1 (switch on; never blocks the creation).
  -- Batch 3: a referral draft has no Bitrix record to fill from (after linking only
  -- the explicit Fill empty fields can fill, F.1.3).
  v_fill := case when p_subject_kind = 'referral'
                 then jsonb_build_object('autoFill', 'unavailable', 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb)
                 else authz.prefill_fill_on_create('quotation_version', v_ver.id) end;
  return jsonb_build_object('quotationId', v_q.id, 'reference', v_q.reference, 'versionId', v_ver.id, 'versionNo', 1,
    'rowVersion', coalesce((v_fill ->> 'rowVersion')::integer, v_ver.row_version), 'created', true,
    'autoFill', v_fill ->> 'autoFill', 'filled', v_fill -> 'filled', 'skipped', v_fill -> 'skipped');
end;
$$;

-- public.itinerary_document_create (replaces 20261120000500_b12_itineraries.sql:596). Batch 3: subject 'referral'; a referral quotation's draft is locked first.
create or replace function public.itinerary_document_create(p_subject_kind text, p_subject_id uuid, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_entity uuid;
  v_branch uuid;
  v_doc public.itinerary_documents%rowtype;
  v_draft public.itinerary_fact_drafts%rowtype;
  v_rd public.referral_drafts%rowtype;  -- Batch 3
begin
  if p_subject_kind is null or p_subject_kind not in ('quotation', 'deal', 'referral') or p_subject_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'subjectKind';
  end if;
  if p_subject_kind = 'deal' then
    perform authz.refuse_removed_deal(p_subject_id);
    if not authz.can_edit_booking_draft(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select d.legal_entity_id, d.branch_id into v_entity, v_branch from public.deals d where d.id = p_subject_id;
  elsif p_subject_kind = 'referral' then
    -- Batch 3: authorization first, then the draft row (draft_closed).
    if not authz.referral_draft_can_edit(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_rd := authz.referral_draft_lock_write(p_subject_id);
    v_entity := v_rd.legal_entity_id;
    v_branch := v_rd.branch_id;
  else
    perform authz.refuse_removed_deal(authz.quotation_deal(p_subject_id));
    if not authz.quotation_can_edit(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select q.legal_entity_id, q.branch_id into v_entity, v_branch from public.quotations q where q.id = p_subject_id;
    -- Batch 3: a referral quotation's draft is locked (draft_closed).
    if (select q.referral_draft_id from public.quotations q where q.id = p_subject_id) is not null then
      perform authz.referral_draft_lock_write((select q.referral_draft_id from public.quotations q where q.id = p_subject_id));
    end if;
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if length(v_title) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'title';
  end if;
  select * into v_doc from public.itinerary_documents d where d.created_by = (select auth.uid()) and d.request_id = p_request_id;
  if v_doc.id is not null then
    if v_doc.title is distinct from v_title or coalesce(v_doc.quotation_id, v_doc.deal_id, v_doc.referral_draft_id) is distinct from p_subject_id then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_doc.id;
    return jsonb_build_object('documentId', v_doc.id, 'draftId', v_draft.id, 'rowVersion', v_draft.row_version, 'created', false);
  end if;
  insert into public.itinerary_documents (legal_entity_id, branch_id, quotation_id, deal_id, referral_draft_id, title, request_id,
    created_by)
  values (v_entity, v_branch, case when p_subject_kind = 'quotation' then p_subject_id end,
    case when p_subject_kind = 'deal' then p_subject_id end,
    case when p_subject_kind = 'referral' then p_subject_id end,  -- Batch 3
    v_title, p_request_id, (select auth.uid()))
  returning * into v_doc;
  insert into public.itinerary_fact_drafts (document_id, legal_entity_id, facts, facts_hash, created_by, updated_by)
  values (v_doc.id, v_entity, '{}'::jsonb, authz.itinerary_facts_hash('{}'::jsonb), (select auth.uid()), (select auth.uid()))
  returning * into v_draft;
  perform authz.itinerary_audit('itinerary.document_created', v_doc.id, 'itinerary_document', v_doc.id,
    jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id));
  return jsonb_build_object('documentId', v_doc.id, 'draftId', v_draft.id, 'rowVersion', v_draft.row_version, 'created', true);
end;
$$;

-- public.quotation_list (replaces 20261120000200_b12_quotations.sql:1780). Batch 3: subject kind 'referral' (a draft's quotations, Echo-B M5); referral rows say subjectKind 'referral' (bound ones too) and carry referralDraftId.
create or replace function public.quotation_list(p_subject_kind text, p_subject_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_id is null or p_subject_kind is null
     or (p_subject_kind = 'deal' and not authz.can_edit_booking_draft(p_subject_id))
     or (p_subject_kind = 'lead' and not authz.quotation_lead_editor(p_subject_id))
     or (p_subject_kind = 'referral' and not authz.referral_draft_can_edit(p_subject_id))  -- Batch 3 (Echo-B M5)
     or p_subject_kind not in ('lead', 'deal', 'referral')
     or (p_subject_kind = 'deal' and exists (select 1 from public.deals d where d.id = p_subject_id and d.removed_at is not null)) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'quotationId', q.id, 'reference', q.reference, 'title', q.title, 'rowVersion', q.row_version,
        'subjectKind', case when q.lead_id is not null then 'lead' when q.referral_draft_id is not null then 'referral' else 'deal' end,
        'referralDraftId', q.referral_draft_id,  -- Batch 3
        'leadId', q.lead_id, 'dealId', q.deal_id, 'linkedDealId', q.linked_deal_id,
        'acceptedVersionId', q.accepted_version_id, 'converted', q.converted_at is not null,
        'bookingVersionId', (select c.booking_version_id from public.quotation_conversions c where c.quotation_id = q.id),
        'createdAt', q.created_at,
        'versions', (select jsonb_agg(authz.quotation_version_json(v) order by v.version_no desc)
                     from public.quotation_versions v where v.quotation_id = q.id)) order by q.created_at desc, q.id)
    from public.quotations q
    where (p_subject_kind = 'lead' and q.lead_id = p_subject_id)
       or (p_subject_kind = 'deal' and (q.deal_id = p_subject_id or q.linked_deal_id = p_subject_id))
       or (p_subject_kind = 'referral' and q.referral_draft_id = p_subject_id)), '[]'::jsonb);  -- Batch 3 (Echo-B M5)
end;
$$;

-- public.quotation_link_candidates (replaces 20261120000200_b12_quotations.sql:1865). Batch 3: a referral quotation's candidate is the draft's active Deal link only.
create or replace function public.quotation_link_candidates(p_quotation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q public.quotations;
  v_lead public.crm_leads;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_q from public.quotations q where q.id = p_quotation_id;
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) or authz.quotation_deal_removed(v_q.id) then
    return null;
  end if;
  -- Batch 3: binding a referral quotation needs the draft's active Deal link.
  if v_q.referral_draft_id is not null then
    return coalesce((
      select jsonb_agg(jsonb_build_object('dealId', d.id, 'reference', d.reference, 'title', d.title,
          'branchName', (select b.name from public.branches b where b.id = d.branch_id),
          'sameBranch', d.branch_id = v_q.branch_id, 'active', d.removed_at is null and not authz.deal_not_active(d.id),
          'linkable', d.branch_id = v_q.branch_id and d.removed_at is null and not authz.deal_not_active(d.id)
                      and authz.can_edit_booking_draft(d.id)
                      and not exists (select 1 from public.quotations o where o.id <> v_q.id
                                      and (o.linked_deal_id = d.id or (o.deal_id = d.id and o.accepted_version_id is not null))))
        order by d.created_at, d.id)
      from public.referral_draft_links k join public.deals d on d.id = k.deal_id
      where k.referral_draft_id = v_q.referral_draft_id and k.ended_at is null and authz.can_read_deal(d.id)), '[]'::jsonb);
  end if;
  if v_q.lead_id is null then
    return '[]'::jsonb;
  end if;
  select * into v_lead from public.crm_leads l where l.id = v_q.lead_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('dealId', d.id, 'reference', d.reference, 'title', d.title,
        'branchName', (select b.name from public.branches b where b.id = d.branch_id),
        'sameBranch', d.branch_id = v_q.branch_id, 'active', d.removed_at is null and not authz.deal_not_active(d.id),
        'linkable', d.branch_id = v_q.branch_id and d.removed_at is null and not authz.deal_not_active(d.id)
                    and authz.can_edit_booking_draft(d.id)
                    and not exists (select 1 from public.quotations o where o.id <> v_q.id and o.accepted_version_id is not null
                                    and (o.deal_id = d.id or o.linked_deal_id = d.id))) order by d.created_at, d.id)
    from public.deals d
    where d.legal_entity_id = v_q.legal_entity_id and d.source_portal = v_lead.source_portal
      and d.source_lead_id = v_lead.source_lead_id and authz.can_read_deal(d.id)), '[]'::jsonb);
end;
$$;

-- public.quotation_get (replaces 20261122000100_prefill_auto_fill.sql:2538). Batch 3: referral subject, draft state, canEdit false while closed, suggestions from the linked record.
create or replace function public.quotation_get(p_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions;
  v_q public.quotations;
  v_result jsonb;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_ver from public.quotation_versions v where v.id = p_version_id;
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) or authz.quotation_deal_removed(v_q.id) then
    return null;
  end if;
  v_result := jsonb_build_object(
    'quotationId', v_q.id, 'reference', v_q.reference, 'title', v_q.title, 'rowVersion', v_q.row_version,
    'subject', jsonb_build_object('kind', case when v_q.lead_id is not null then 'lead'
                                              when v_q.referral_draft_id is not null then 'referral' else 'deal' end,
      'referralDraftId', v_q.referral_draft_id,  -- Batch 3
      'leadId', v_q.lead_id, 'dealId', v_q.deal_id, 'linkedDealId', v_q.linked_deal_id,
      -- B1.2 0800 (DEC-50): the quotation's own branch (quotations.branch_id, fixed at creation).
      'branchCode', (select b.code from public.branches b where b.id = v_q.branch_id),
      'reference', coalesce((select l.reference from public.crm_leads l where l.id = v_q.lead_id),
                            (select d.reference from public.deals d where d.id = v_q.deal_id),
                            (select r.reference from public.referral_drafts r where r.id = v_q.referral_draft_id)),  -- Batch 3
      'title', coalesce((select l.title from public.crm_leads l where l.id = v_q.lead_id),
                        (select d.title from public.deals d where d.id = v_q.deal_id),
                        (select r.customer_name from public.referral_drafts r where r.id = v_q.referral_draft_id))),
    'version', authz.quotation_version_json(v_ver),
    'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD')),
    'pax', jsonb_build_object('adults', v_ver.adults, 'childrenWithBed', v_ver.children_with_bed,
      'childrenNoBed', v_ver.children_no_bed, 'infants', v_ver.infants, 'remarks', v_ver.pax_remarks),
    'requirementsNote', v_ver.requirements_note,
    'content', v_ver.content,
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('tierKey', t.tier_key, 'label', t.label) order by t.tier_key)
                       from public.quotation_version_tiers t where t.quotation_version_id = v_ver.id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('itemId', i.id, 'itemNo', i.item_no, 'serviceType', i.service_type,
                         'tierKey', i.tier_key,
                         'title', coalesce(nullif(authz.service_item_title(i.service_type, i.facts), ''), initcap(i.service_type)),
                         'facts', i.facts,
                         'factsValid', cardinality(authz.validate_service_facts(i.service_type, i.facts)) = 0) order by i.item_no)
                       from public.quotation_version_items i where i.quotation_version_id = v_ver.id), '[]'::jsonb),
    'contacts', (select jsonb_build_object('contactName', c.contact_name, 'mobile', c.mobile, 'email', c.email,
                   'companyName', c.company_name, 'bookingFor', c.booking_for)
                 from public.quotation_version_contacts c where c.quotation_version_id = v_ver.id),
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'fileName', e.file_name, 'mime', e.mime,
                            'sizeBytes', e.size_bytes, 'status', e.status, 'createdAt', e.created_at, 'storedAt', e.stored_at,
                            'uploadedByYou', e.uploaded_by = (select auth.uid())) order by e.created_at, e.id)
                          from public.quotation_evidence e where e.quotation_version_id = v_ver.id and e.status <> 'removed'), '[]'::jsonb),
    'issues', case when v_ver.status = 'draft' then to_jsonb(authz.quotation_issues(v_ver.id)) else '[]'::jsonb end,
    'canEdit', v_ver.status in ('draft', 'ready') and v_q.converted_at is null
               and (v_q.referral_draft_id is null or not authz.referral_draft_closed(v_q.referral_draft_id)),  -- Batch 3
    'conversion', (select jsonb_build_object('bookingVersionId', c.booking_version_id, 'dealId', c.deal_id, 'createdAt', c.created_at)
                   from public.quotation_conversions c where c.quotation_version_id = v_ver.id));
  -- Batch 3: the referral draft's state (null for Lead and Deal quotations).
  v_result := v_result || jsonb_build_object('referral',
    case when v_q.referral_draft_id is not null then authz.referral_draft_brief(v_q.referral_draft_id) end);
  -- B1.2 0600: Bitrix values of the quotation's Deal or Lead (DEC-36); the caller is an editor.
  v_result := v_result || jsonb_build_object('prefill',
    authz.prefill_view(authz.quotation_bitrix_subject(v_q.id) ->> 'kind',  -- Batch 3
      (authz.quotation_bitrix_subject(v_q.id) ->> 'id')::uuid,
      'quotation_version', v_ver.id, authz.quotation_money_can_read(v_q.id))
    || jsonb_build_object('unchecked', coalesce((select jsonb_agg(m.field_code order by m.field_code) from public.prefill_marks m
         where m.target_kind = 'quotation_version' and m.target_id = v_ver.id and m.state in ('from_bitrix', 'kept')), '[]'::jsonb)));
  if authz.quotation_money_can_read(v_q.id) then
    v_result := v_result || jsonb_build_object('money', authz.quotation_money_json(v_ver.id));
  end if;
  return v_result;
end;
$$;

-- public.itinerary_document_list (replaces 20261120000500_b12_itineraries.sql:1193). Batch 3: subject 'referral' (documents made straight on a draft).
create or replace function public.itinerary_document_list(p_subject_kind text, p_subject_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_id is null or p_subject_kind is null or p_subject_kind not in ('quotation', 'deal', 'referral')
     or (p_subject_kind = 'referral' and not authz.referral_draft_can_edit(p_subject_id))  -- Batch 3
     or (p_subject_kind = 'deal' and not authz.can_edit_booking_draft(p_subject_id))
     or (p_subject_kind = 'quotation' and not authz.quotation_can_edit(p_subject_id))
     -- Review E3-12: nothing for a Deal removed by the sync.
     or exists (select 1 from public.deals d where d.removed_at is not null
                and d.id = case when p_subject_kind = 'deal' then p_subject_id else authz.quotation_deal(p_subject_id) end) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('documentId', d.id, 'title', d.title,
        'subjectKind', case when d.quotation_id is not null then 'quotation'
                            when d.referral_draft_id is not null then 'referral' else 'deal' end,  -- Batch 3
        'draftStatus', f.status, 'factsHash', f.facts_hash, 'createdAt', d.created_at,
        'latestFinal', (select jsonb_build_object('renderedId', r.id, 'createdAt', r.created_at)
                        from public.itinerary_rendered_documents r where r.document_id = d.id and r.kind = 'final'
                        order by r.created_at desc limit 1)) order by d.created_at desc, d.id)
    from public.itinerary_documents d
    join public.itinerary_fact_drafts f on f.document_id = d.id
    where (p_subject_kind = 'quotation' and d.quotation_id = p_subject_id)
       or (p_subject_kind = 'deal' and d.deal_id = p_subject_id)
       or (p_subject_kind = 'referral' and d.referral_draft_id = p_subject_id)), '[]'::jsonb);  -- Batch 3
end;
$$;

-- public.itinerary_document_get (replaces 20261120000800_b12_document_branch_code.sql:96). Batch 3: referral subject and the draft's state.
create or replace function public.itinerary_document_get(p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents;
  v_draft public.itinerary_fact_drafts;
  v_run public.itinerary_difference_runs;
  v_latest public.itinerary_difference_runs;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_doc from public.itinerary_documents d where d.id = p_document_id;
  if v_doc.id is null or not authz.itinerary_can_edit(v_doc.id)
     or exists (select 1 from public.deals d where d.id = authz.itinerary_deal(v_doc.id) and d.removed_at is not null) then
    return null;
  end if;
  select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_doc.id;
  v_run := authz.itinerary_current_run(v_draft.id);
  select * into v_latest from public.itinerary_difference_runs r where r.draft_id = v_draft.id
  order by r.created_at desc, r.id desc limit 1;
  return jsonb_build_object(
    'documentId', v_doc.id, 'title', v_doc.title,
    'subject', jsonb_build_object('kind', case when v_doc.quotation_id is not null then 'quotation'
                                              when v_doc.referral_draft_id is not null then 'referral' else 'deal' end,
      'referralDraftId', coalesce(v_doc.referral_draft_id,
        (select q.referral_draft_id from public.quotations q where q.id = v_doc.quotation_id)),  -- Batch 3
      'quotationId', v_doc.quotation_id, 'dealId', coalesce(v_doc.deal_id, authz.quotation_deal(v_doc.quotation_id)),
      -- B1.2 0800 (DEC-50): the document's own branch (itinerary_documents.branch_id, immutable);
      -- itinerary_render_input reads the same column.
      'branchCode', (select b.code from public.branches b where b.id = v_doc.branch_id)),
    'draft', jsonb_build_object('draftId', v_draft.id, 'status', v_draft.status, 'rowVersion', v_draft.row_version,
      'facts', v_draft.facts, 'factsHash', v_draft.facts_hash, 'sourceFileId', v_draft.source_file_id, 'updatedAt', v_draft.updated_at),
    -- Batch 3: the referral draft's state (documents on a draft or a referral quotation).
    'referral', (select authz.referral_draft_brief(x.id) from (select coalesce(v_doc.referral_draft_id,
        (select q.referral_draft_id from public.quotations q where q.id = v_doc.quotation_id)) as id) x where x.id is not null),
    'basis', authz.itinerary_basis(v_doc.id),
    -- DEC-48: the customer prices printed on the itinerary, for callers who may read them.
    'money', case when authz.itinerary_money_reader(v_doc.id) then authz.itinerary_money_json(authz.itinerary_basis(v_doc.id)) end,
    'differences', jsonb_build_object('runId', coalesce(v_run.id, v_latest.id), 'current', v_run.id is not null,
      'items', coalesce((select jsonb_agg(jsonb_build_object('differenceId', d.id, 'path', d.field_path, 'kind', d.difference,
                'acknowledged', d.acknowledged_at is not null,
                'acknowledgedByName', (select p.display_name from public.staff_profiles p where p.user_id = d.acknowledged_by),
                'acknowledgedAt', d.acknowledged_at, 'note', d.note) order by d.field_path, d.difference)
              from public.itinerary_fact_differences d where d.run_id = coalesce(v_run.id, v_latest.id)), '[]'::jsonb)),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('fileId', s.id, 'fileName', s.file_name, 'mime', s.mime,
                'sizeBytes', s.size_bytes, 'status', s.status, 'createdAt', s.created_at) order by s.created_at, s.id)
              from public.itinerary_source_files s where s.document_id = v_doc.id and s.status <> 'removed'), '[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
                select jsonb_build_object('jobId', j.id, 'kind', j.kind, 'status', j.status, 'attempts', j.attempts,
                  'lastErrorCode', j.last_error_code, 'createdAt', j.created_at, 'finishedAt', j.finished_at) as j, j.created_at
                from public.itinerary_render_jobs j where j.document_id = v_doc.id order by j.created_at desc limit 20) x), '[]'::jsonb),
    'rendered', coalesce((select jsonb_agg(jsonb_build_object('renderedId', r.id, 'kind', r.kind, 'pageCount', r.page_count,
                'sizeBytes', r.size_bytes, 'createdAt', r.created_at, 'qa', r.qa) order by r.created_at desc)
              from public.itinerary_rendered_documents r where r.document_id = v_doc.id), '[]'::jsonb));
end;
$$;

-- authz.prefill_fill (replaces 20261122000100_prefill_auto_fill.sql:628). Batch 3: a referral quotation reads the record it is linked to; unlinked = unavailable.
create or replace function authz.prefill_fill(p_kind text, p_target uuid, p_mode text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_bv public.booking_versions%rowtype;
  v_qv public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_entity uuid;
  v_branch uuid;
  v_subject_kind text;
  v_subject uuid;
  v_show_notes boolean := false;
  v jsonb;
  f jsonb;
  v_codes text[];
  v_field text;
  v_block text;
  v_cand jsonb := '{}'::jsonb;
  v_filled text[] := '{}'::text[];
  v_skipped jsonb := '[]'::jsonb;
  v_start date;
  v_end date;
  v_old_start date;
  v_old_end date;
  v_trip text[] := '{}'::text[];
  v_contact_fields text[] := '{}'::text[];
  v_bc public.booking_version_contacts%rowtype;
  v_qc public.quotation_version_contacts%rowtype;
  v_name text;
  v_mobile text;
  v_email text;
  v_company text;
  v_for text;
  v_rv integer;
  v_modified timestamptz;
  v_contact_ok boolean := false;  -- Echo L4
  v_returned boolean := false;
begin
  if p_mode not in ('create', 'fill_empty') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'mode';
  end if;
  if p_kind = 'booking_version' then
    select * into v_bv from public.booking_versions b where b.id = p_target;
    v_entity := v_bv.legal_entity_id;
    v_branch := v_bv.branch_id;
    v_subject_kind := 'deal';
    v_subject := v_bv.deal_id;
    v_codes := array['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor'];
    v_old_start := v_bv.trip_start;
    v_old_end := v_bv.trip_end;
    v_rv := v_bv.row_version;
  else
    select * into v_qv from public.quotation_versions qv where qv.id = p_target;
    select * into v_q from public.quotations q where q.id = v_qv.quotation_id;
    v_entity := v_qv.legal_entity_id;
    v_branch := v_q.branch_id;
    v_subject_kind := authz.quotation_bitrix_subject(v_q.id) ->> 'kind';  -- Batch 3
    v_subject := (authz.quotation_bitrix_subject(v_q.id) ->> 'id')::uuid;
    -- Lead decision A2: Booking Notes fill the requirements note only for callers with price scope.
    v_show_notes := authz.quotation_money_can_read(v_q.id);
    v_codes := array['trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile', 'contacts.email',
      'contacts.companyName', 'contacts.bookingFor'];
    v_old_start := v_qv.trip_start;
    v_old_end := v_qv.trip_end;
    v_rv := v_qv.row_version;
  end if;
  -- Batch 3: an unlinked referral quotation has no Bitrix record.
  if v_subject is null then
    return jsonb_build_object('outcome', 'unavailable', 'rowVersion', v_rv, 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  v := authz.bitrix_prefill_json(v_subject_kind, v_subject);
  if not coalesce((v ->> 'available')::boolean, false) then
    return jsonb_build_object('outcome', 'unavailable', 'rowVersion', v_rv, 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  f := v -> 'fields';
  v_modified := (v ->> 'sourceModifiedAt')::timestamptz;

  -- Which fields may be written, and with what (one predicate, F.1.3).
  foreach v_field in array v_codes loop
    v_block := authz.prefill_field_block(p_kind, p_target, v_field, true);
    if v_block = 'not_empty' then
      continue;
    elsif v_block is not null then
      v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', v_block);
    elsif authz.prefill_candidate(f, v_field, v_show_notes) is null then
      v_skipped := v_skipped || jsonb_build_object('field', v_field,
        'reason', authz.prefill_candidate_reason(f, v_field, v_show_notes));
    else
      v_cand := v_cand || jsonb_build_object(v_field, authz.prefill_candidate(f, v_field, v_show_notes));
    end if;
  end loop;

  perform set_config('tripnavigate.prefill_apply', p_target::text, true);

  -- Trip dates (and the quotation's requirements note): order checked against the merged values.
  v_start := coalesce((v_cand ->> 'trip.start')::date, v_old_start);
  v_end := coalesce((v_cand ->> 'trip.end')::date, v_old_end);
  foreach v_field in array array['trip.start', 'trip.end'] loop
    if v_cand ? v_field then
      if v_start is not null and v_end is not null and v_end < v_start then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'date_order');
      else
        v_trip := v_trip || v_field;
      end if;
    end if;
  end loop;

  -- Contact plan: merged with the saved row; needs a name and a mobile or e-mail (nothing written yet).
  select array_agg(x order by x) into v_contact_fields from unnest(v_codes) x where x like 'contacts.%' and v_cand ? x;
  v_contact_fields := coalesce(v_contact_fields, '{}'::text[]);
  if cardinality(v_contact_fields) > 0 then
    if p_kind = 'booking_version' then
      select * into v_bc from public.booking_version_contacts c where c.booking_version_id = p_target;
      v_name := coalesce(v_cand ->> 'contacts.contactName', v_bc.contact_name);
      v_mobile := coalesce(v_cand ->> 'contacts.mobile', v_bc.mobile);
      v_email := coalesce(v_cand ->> 'contacts.email', v_bc.email);
      v_for := coalesce(v_cand ->> 'contacts.bookingFor', v_bc.booking_for, 'individual');
    else
      select * into v_qc from public.quotation_version_contacts c where c.quotation_version_id = p_target;
      v_name := coalesce(v_cand ->> 'contacts.contactName', v_qc.contact_name);
      v_mobile := coalesce(v_cand ->> 'contacts.mobile', v_qc.mobile);
      v_email := coalesce(v_cand ->> 'contacts.email', v_qc.email);
      v_company := coalesce(v_cand ->> 'contacts.companyName', v_qc.company_name);
      v_for := coalesce(v_cand ->> 'contacts.bookingFor', v_qc.booking_for);
    end if;
    if v_name is null then
      v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_name_missing')) from unnest(v_contact_fields) x);
    elsif v_mobile is null and v_email is null then
      v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_needs_mobile_or_email')) from unnest(v_contact_fields) x);
    else
      v_contact_ok := true;
    end if;
  end if;

  -- Echo L4: a ready quotation returns to draft only when something will be
  -- written (the row-version bump and the fill audit below record it).
  if p_kind = 'quotation_version' and v_qv.status = 'ready'
     and (cardinality(v_trip) > 0 or v_cand ? 'requirementsNote' or v_contact_ok) then
    update public.quotation_versions qv set status = 'draft', content_hash = null where qv.id = p_target;
    v_returned := true;
  end if;

  if p_kind = 'booking_version' then
    if cardinality(v_trip) > 0 then
      update public.booking_versions b
      set trip_start = case when 'trip.start' = any (v_trip) then (v_cand ->> 'trip.start')::date else b.trip_start end,
          trip_end = case when 'trip.end' = any (v_trip) then (v_cand ->> 'trip.end')::date else b.trip_end end
      where b.id = p_target
      returning * into v_bv;
      v_filled := v_filled || v_trip;
    end if;
  else
    if cardinality(v_trip) > 0 or v_cand ? 'requirementsNote' then
      update public.quotation_versions qv
      set trip_start = case when 'trip.start' = any (v_trip) then (v_cand ->> 'trip.start')::date else qv.trip_start end,
          trip_end = case when 'trip.end' = any (v_trip) then (v_cand ->> 'trip.end')::date else qv.trip_end end,
          requirements_note = case when v_cand ? 'requirementsNote' then v_cand ->> 'requirementsNote' else qv.requirements_note end
      where qv.id = p_target;
      v_filled := v_filled || v_trip;
      if v_cand ? 'requirementsNote' then
        v_filled := v_filled || 'requirementsNote'::text;
      end if;
    end if;
  end if;

  if v_contact_ok then
    if p_kind = 'booking_version' then
      perform authz.b11_contacts_write(v_bv, jsonb_build_object('contactName', v_name, 'mobile', v_mobile, 'email', v_email,
        -- Fills never confirm; an existing confirmation stays only while the mobile and e-mail are not written.
        'contactConfirmed', coalesce(v_bc.contact_confirmed, false)
                            and not (v_contact_fields && array['contacts.mobile', 'contacts.email']),
        'bookingFor', v_for, 'payerDifferent', coalesce(v_bc.payer_different, false), 'payerName', v_bc.payer_name));
    else
      insert into public.quotation_version_contacts as c (quotation_version_id, legal_entity_id, contact_name, mobile, email,
        company_name, booking_for, updated_by)
      values (p_target, v_entity, v_name, v_mobile, v_email, v_company, v_for, (select auth.uid()))
      on conflict (quotation_version_id) do update
        set contact_name = excluded.contact_name, mobile = excluded.mobile, email = excluded.email,
            company_name = excluded.company_name, booking_for = excluded.booking_for,
            updated_by = excluded.updated_by, updated_at = now();
    end if;
    v_filled := v_filled || v_contact_fields;
  end if;

  foreach v_field in array v_filled loop
    perform authz.prefill_mark(v_entity, p_kind, p_target, v_field, v_subject_kind, v_modified,
      case p_mode when 'create' then 'auto_fill' else 'fill_empty' end);
  end loop;
  if cardinality(v_filled) > 0 then
    if p_kind = 'booking_version' then
      v_rv := (authz.bump_package_version(p_target)).row_version;
    else
      v_rv := (authz.bump_quotation_version(p_target)).row_version;
    end if;
  end if;
  perform set_config('tripnavigate.prefill_apply', '', true);

  select coalesce(array_agg(x order by x), '{}'::text[]) into v_filled from unnest(v_filled) x;
  insert into public.prefill_fill_runs (legal_entity_id, target_kind, target_id, mode, source_object, source_modified_at, filled,
    skipped, ran_by)
  values (v_entity, p_kind, p_target, p_mode, v_subject_kind, v_modified, v_filled, v_skipped, (select auth.uid()));
  perform authz.write_audit(
    case when p_kind = 'booking_version' then 'booking.' else 'quotation.' end
      || case p_mode when 'create' then 'prefill_auto_filled' else 'prefill_filled_empty' end,
    v_entity, v_branch, p_kind, p_target, null,
    jsonb_build_object('versionId', p_target, 'fields', to_jsonb(v_filled), 'skipped', v_skipped,
      'sourceModifiedAt', v_modified, 'rowVersion', v_rv)
    || case when v_returned then jsonb_build_object('returnedToDraft', true) else '{}'::jsonb end
    || case when p_kind = 'booking_version' then jsonb_build_object('dealId', v_bv.deal_id)
            else jsonb_build_object('quotationId', v_q.id) end);
  return jsonb_build_object('outcome', 'filled', 'rowVersion', v_rv, 'filled', to_jsonb(v_filled), 'skipped', v_skipped);
end;
$$;

-- public.prefill_notice_dismiss (replaces 20261122000100_prefill_auto_fill.sql:962). Batch 3: a referral quotation's linked record.
create or replace function public.prefill_notice_dismiss(p_target_kind text, p_target_id uuid, p_expected_row_version integer,
  p_field text, p_source_modified_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_branch uuid;
  v_rv integer;
  v_subject_kind text;  -- Echo L5
  v_subject uuid;
begin
  if p_target_kind = 'booking_version' then
    declare
      v_ver public.booking_versions%rowtype;
    begin
      v_ver := authz.lock_package_draft(p_target_id);
      v_entity := v_ver.legal_entity_id;
      v_branch := v_ver.branch_id;
      v_rv := v_ver.row_version;
      v_subject_kind := 'deal';
      v_subject := v_ver.deal_id;
    end;
  elsif p_target_kind = 'quotation_version' then
    declare
      v_ver public.quotation_versions%rowtype;
    begin
      v_ver := authz.lock_quotation_version(p_target_id);
      if v_ver.status not in ('draft', 'ready') then
        raise exception 'wrong_state' using errcode = '55000';
      end if;
      v_entity := v_ver.legal_entity_id;
      select q.branch_id, authz.quotation_bitrix_subject(q.id) ->> 'kind', (authz.quotation_bitrix_subject(q.id) ->> 'id')::uuid  -- Batch 3
      into v_branch, v_subject_kind, v_subject
      from public.quotations q where q.id = v_ver.quotation_id;
      v_rv := v_ver.row_version;
    end;
  else
    raise exception 'invalid_input' using errcode = '22023', hint = 'targetKind';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_rv);
  if p_field is null or p_field not in ('trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile',
       'contacts.email', 'contacts.companyName', 'contacts.bookingFor')
     or (p_target_kind = 'booking_version' and p_field in ('requirementsNote', 'contacts.companyName')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'field';
  end if;
  -- Echo L5: only a snapshot time that exists (never later than the current
  -- snapshot), so a dismissal cannot hide future Bitrix changes.
  if p_source_modified_at is null
     or p_source_modified_at > coalesce(case when v_subject is not null  -- Batch 3: unlinked referral = no snapshot
                                             then (authz.bitrix_prefill_json(v_subject_kind, v_subject) ->> 'sourceModifiedAt')::timestamptz end,
                                        '-infinity'::timestamptz) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceModifiedAt';
  end if;
  insert into public.prefill_notice_dismissals (legal_entity_id, target_kind, target_id, field_code, source_modified_at, dismissed_by)
  values (v_entity, p_target_kind, p_target_id, p_field, p_source_modified_at, (select auth.uid()))
  on conflict (target_kind, target_id, field_code, source_modified_at) do nothing;
  perform authz.write_audit('prefill.notice_kept', v_entity, v_branch, p_target_kind, p_target_id, null,
    jsonb_build_object('targetKind', p_target_kind, 'targetId', p_target_id, 'field', p_field,
      'sourceModifiedAt', p_source_modified_at));
  return jsonb_build_object('field', p_field, 'sourceModifiedAt', p_source_modified_at, 'dismissed', true);
end;
$$;

-- public.quotation_prefill_apply (replaces 20261122000100_prefill_auto_fill.sql:2004). Batch 3: a referral quotation's linked record; unlinked = prefill_unavailable.
create or replace function public.quotation_prefill_apply(p_version_id uuid, p_expected_row_version integer, p_fields text[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_kind text;
  v jsonb;
  f jsonb;
  v_allowed constant text[] := array['trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile',
    'contacts.email', 'contacts.companyName', 'contacts.bookingFor'];
  v_booking_for text;
  v_field text;
  v_applied text[] := '{}'::text[];
  v_skipped jsonb := '[]'::jsonb;
  v_start date;
  v_end date;
  v_save jsonb := '{}'::jsonb;
  v_rv integer;
  v_contact public.quotation_version_contacts%rowtype;
  v_name text;
  v_mobile text;
  v_email text;
  v_company text;
  v_contact_fields text[] := '{}'::text[];
  v_on boolean := authz.prefill_auto_fill_enabled();  -- Batch 2
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or cardinality(p_fields) = 0 or exists (select 1 from unnest(p_fields) x where x <> all (v_allowed)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  v_kind := authz.quotation_bitrix_subject(v_q.id) ->> 'kind';  -- Batch 3
  v := case when v_kind is null then jsonb_build_object('available', false)
            else authz.bitrix_prefill_json(v_kind, (authz.quotation_bitrix_subject(v_q.id) ->> 'id')::uuid) end;
  if not coalesce((v ->> 'available')::boolean, false) then
    raise exception 'prefill_unavailable' using errcode = '55000';
  end if;
  -- Batch 2 ("Use it", switch on only; lead ruling 20 Oct: off = today):
  -- an accepted quotation's value and a field staff cleared are not refilled.
  if v_on then
    select coalesce(jsonb_agg(jsonb_build_object('field', x, 'reason', r) order by x), '[]'::jsonb) into v_skipped
    from (select x, case when exists (select 1 from public.prefill_marks m
                                       where m.target_kind = 'quotation_version' and m.target_id = v_ver.id and m.field_code = x
                                         and m.state = 'replaced_by_quotation') then 'accepted_quotation'
                         when nullif(btrim(coalesce(authz.prefill_saved_value('quotation_version', v_ver.id, x), '')), '') is null
                              and authz.prefill_cleared_last('quotation_version', v_ver.id, x) then 'cleared_by_staff' end as r
          from unnest(p_fields) x) z
    where r is not null;
    select coalesce(array_agg(x), '{}'::text[]) into p_fields from unnest(p_fields) x
    where not exists (select 1 from jsonb_array_elements(v_skipped) e where e ->> 'field' = x);
  end if;
  f := v -> 'fields';
  perform set_config('tripnavigate.prefill_apply', v_ver.id::text, true);
  v_rv := v_ver.row_version;

  v_start := case when 'trip.start' = any (p_fields) and f ->> 'tourStart' is not null then (f ->> 'tourStart')::date else v_ver.trip_start end;
  v_end := case when 'trip.end' = any (p_fields) and f ->> 'tourEnd' is not null then (f ->> 'tourEnd')::date else v_ver.trip_end end;
  foreach v_field in array array['trip.start', 'trip.end'] loop
    if v_field = any (p_fields) then
      if f ->> (case v_field when 'trip.start' then 'tourStart' else 'tourEnd' end) is null then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'no_value');
      elsif v_start is not null and v_end is not null and v_end < v_start then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'date_order');
      else
        v_save := v_save || jsonb_build_object(case v_field when 'trip.start' then 'start' else 'end' end,
          to_char(case v_field when 'trip.start' then v_start else v_end end, 'YYYY-MM-DD'));
        v_applied := v_applied || v_field;
      end if;
    end if;
  end loop;
  if 'requirementsNote' = any (p_fields) then
    -- Review E5-3: Booking Notes only for callers with commercial scope.
    if not authz.quotation_money_can_read(v_q.id) then
      v_skipped := v_skipped || jsonb_build_object('field', 'requirementsNote', 'reason', 'not_allowed');
    elsif f ->> 'bookingNotes' is null then
      v_skipped := v_skipped || jsonb_build_object('field', 'requirementsNote', 'reason', 'no_value');
    else
      v_save := v_save || jsonb_build_object('requirementsNote', left(f ->> 'bookingNotes', 4000));
      v_applied := v_applied || 'requirementsNote'::text;
    end if;
  end if;
  if v_save <> '{}'::jsonb then
    v_rv := (public.quotation_version_save(v_ver.id, v_rv, v_save) ->> 'rowVersion')::integer;
  end if;

  if p_fields && array['contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.companyName', 'contacts.bookingFor'] then
    select * into v_contact from public.quotation_version_contacts c where c.quotation_version_id = v_ver.id;
    v_name := v_contact.contact_name;
    v_mobile := v_contact.mobile;
    v_email := v_contact.email;
    v_company := v_contact.company_name;
    if 'contacts.bookingFor' = any (p_fields) then
      if authz.prefill_booking_for(f) is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.bookingFor', 'reason', 'no_value');
      else
        v_booking_for := authz.prefill_booking_for(f);
        v_contact_fields := v_contact_fields || 'contacts.bookingFor'::text;
      end if;
    end if;
    if 'contacts.contactName' = any (p_fields) then
      if nullif(btrim(coalesce(f -> 'contact' ->> 'name', '')), '') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.contactName', 'reason', 'no_value');
      else
        v_name := left(btrim(f -> 'contact' ->> 'name'), 120);
        v_contact_fields := v_contact_fields || 'contacts.contactName'::text;
      end if;
    end if;
    if 'contacts.mobile' = any (p_fields) then
      if f -> 'contact' ->> 'mobile' is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.mobile', 'reason', 'no_value');
      elsif authz.prefill_mobile(f -> 'contact' ->> 'mobile') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.mobile', 'reason', 'mobile_format');
      else
        v_mobile := authz.prefill_mobile(f -> 'contact' ->> 'mobile');
        v_contact_fields := v_contact_fields || 'contacts.mobile'::text;
      end if;
    end if;
    if 'contacts.email' = any (p_fields) then
      if f -> 'contact' ->> 'email' is null
         or length(f -> 'contact' ->> 'email') > 254 or (f -> 'contact' ->> 'email') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.email', 'reason', 'no_value');
      else
        v_email := f -> 'contact' ->> 'email';
        v_contact_fields := v_contact_fields || 'contacts.email'::text;
      end if;
    end if;
    if 'contacts.companyName' = any (p_fields) then
      if nullif(btrim(coalesce(f -> 'company' ->> 'name', '')), '') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.companyName', 'reason', 'no_value');
      else
        v_company := left(btrim(f -> 'company' ->> 'name'), 200);
        v_contact_fields := v_contact_fields || 'contacts.companyName'::text;
      end if;
    end if;
    if cardinality(v_contact_fields) > 0 then
      if v_name is null then
        v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_name_missing')) from unnest(v_contact_fields) x);
      elsif v_mobile is null and v_email is null then
        v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_needs_mobile_or_email')) from unnest(v_contact_fields) x);
      else
        v_rv := (public.quotation_contacts_save(v_ver.id, v_rv, jsonb_build_object('contactName', v_name, 'mobile', v_mobile,
          'email', v_email, 'companyName', v_company)
          || case when v_booking_for is not null then jsonb_build_object('bookingFor', v_booking_for) else '{}'::jsonb end)
          ->> 'rowVersion')::integer;
        v_applied := v_applied || v_contact_fields;
      end if;
    end if;
  end if;

  foreach v_field in array v_applied loop
    perform authz.prefill_mark(v_ver.legal_entity_id, 'quotation_version', v_ver.id, v_field, v_kind, (v ->> 'sourceModifiedAt')::timestamptz);
  end loop;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform set_config('tripnavigate.prefill_apply', '', true);
  perform authz.write_audit('quotation.prefill_applied', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionId', v_ver.id, 'fields', to_jsonb(v_applied), 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'applied', to_jsonb(v_applied), 'skipped', v_skipped);
end;
$$;

-- public.admin_set_workflow_setting (replaces 20261122000100_prefill_auto_fill.sql:2165). Batch 3: key referral_drafts.
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
  v_timeout text;  -- Batch 2
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_key is null or p_key not in ('intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled',
                                    'prefill_auto_fill', 'referral_drafts')  -- Batch 3
     or p_value is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Batch 2 (Echo L11, F.6 N5): wait at most 5 s for the settings row only;
  -- a held row (55P03 here and only here) is settings_busy.
  v_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', '5s', true);
    select * into v_before from public.workflow_settings s where s.id for update;
    perform set_config('lock_timeout', v_timeout, true);
  exception when lock_not_available then
    raise exception 'settings_busy' using errcode = '55P03';
  end;
  if v_before.id is null then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_workflow_setting', v_reason);
  update public.workflow_settings s
  set intake_prompt_enabled = case when p_key = 'intake_prompt_enabled' then p_value else s.intake_prompt_enabled end,
      service_items_enabled = case when p_key = 'service_items_enabled' then p_value else s.service_items_enabled end,
      visa_passport_tasks_enabled = case when p_key = 'visa_passport_tasks_enabled' then p_value
                                         else s.visa_passport_tasks_enabled end,
      prefill_auto_fill = case when p_key = 'prefill_auto_fill' then p_value else s.prefill_auto_fill end,
      referral_drafts = case when p_key = 'referral_drafts' then p_value else s.referral_drafts end  -- Batch 3
  where s.id
  returning * into v_after;
  perform authz.settings_end_change(v_prev);

  v_was := case p_key when 'intake_prompt_enabled' then v_before.intake_prompt_enabled
                      when 'service_items_enabled' then v_before.service_items_enabled
                      when 'prefill_auto_fill' then v_before.prefill_auto_fill
                      when 'referral_drafts' then v_before.referral_drafts  -- Batch 3
                      else v_before.visa_passport_tasks_enabled end;
  v_now := case p_key when 'intake_prompt_enabled' then v_after.intake_prompt_enabled
                      when 'service_items_enabled' then v_after.service_items_enabled
                      when 'prefill_auto_fill' then v_after.prefill_auto_fill
                      when 'referral_drafts' then v_after.referral_drafts  -- Batch 3
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

-- public.workflow_settings_get (replaces 20261122000100_prefill_auto_fill.sql:2274). Batch 3: referralDrafts.
create or replace function public.workflow_settings_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return (select jsonb_build_object('intakePromptEnabled', s.intake_prompt_enabled,
    'serviceItemsEnabled', s.service_items_enabled,
    -- B1.1
    'visaPassportTasksEnabled', s.visa_passport_tasks_enabled,
    -- Batch 2
    'prefillAutoFill', s.prefill_auto_fill,
    -- Batch 3
    'referralDrafts', s.referral_drafts,
    'updatedAt', s.updated_at)
    from public.workflow_settings s where s.id);
end;
$$;

-- public.my_work_counts (replaces 20261121000120_my_work_list.sql:55). Batch 3 (FP-081): quotationDraftsToFinish and acceptedQuotesToLink.
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
  -- Batch 1 B1-3
  v_drafts integer;
  v_n integer;
  -- Batch 3
  v_to_finish integer;
  v_to_link integer;
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
    -- Batch 1 B1-3 (Echo L7): one scan gives the existing counts and the
    -- drafts the caller may continue, exactly the rows of
    -- my_work_list('drafts') (Deals removed by the sync are left out; the
    -- deals join is one-to-one, so waitingForMe and missingDetails keep
    -- their values).
    select count(*), count(*) filter (where cardinality(authz.booking_issues(v.id)) > 0),
           count(*) filter (where d.removed_at is null)
    into v_waiting, v_missing, v_drafts
    from public.booking_versions v
    join public.deals d on d.id = v.deal_id
    where v.status = 'draft' and authz.can_edit_booking_draft(v.deal_id);
    select count(distinct d.id) into v_returned
    from public.deals d
    join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id and rv.status = 'returned'
    where d.removed_at is null
      and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
           or authz.is_branch_sales_manager(d.id));
    -- Batch 3 (FP-081): exactly the rows of my_work_list('quotation_drafts' / 'accepted_to_link').
    select count(*) filter (where w.to_finish), count(*) filter (where w.accepted_not_linked)
    into v_to_finish, v_to_link
    from authz.work_quotation_rows() w;
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
    'expensesToReview', authz.finance_expenses_to_review_count(),
    -- Batch 1 B1-3: null when the caller holds no active Sales or Manager role.
    'draftsToContinue', v_drafts,
    -- Batch 3 (FP-081): null when the caller holds no active Sales or Manager role.
    'quotationDraftsToFinish', v_to_finish,
    'acceptedQuotesToLink', v_to_link);
end;
$$;

-- public.my_work_list (replaces 20261121000120_my_work_list.sql:197). Batch 3 (FP-081): kinds quotation_drafts and accepted_to_link.
create or replace function public.my_work_list(p_kind text, p_after jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_sales boolean;
  v_manager boolean;
  v_limit integer := coalesce(p_limit, 20);
  v_after_since timestamptz;
  v_after_deal uuid;
  v_page jsonb;
  v_n integer;
  v_last jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('drafts', 'missing_details', 'returned', 'needs_booking', 'quotation_drafts', 'accepted_to_link') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if v_limit not between 1 and 50 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_after is not null and jsonb_typeof(p_after) <> 'null' then
    begin
      if jsonb_typeof(p_after) <> 'object' or jsonb_typeof(p_after -> 'since') is distinct from 'string'
         or jsonb_typeof(p_after -> case when p_kind in ('quotation_drafts', 'accepted_to_link') then 'quotationId' else 'dealId' end) is distinct from 'string'  -- Batch 3
         or exists (select 1 from jsonb_object_keys(p_after) k where k not in ('since', case when p_kind in ('quotation_drafts', 'accepted_to_link') then 'quotationId' else 'dealId' end)) then
        raise exception 'bad cursor';
      end if;
      v_after_since := (p_after ->> 'since')::timestamptz;
      v_after_deal := coalesce(p_after ->> 'dealId', p_after ->> 'quotationId')::uuid;  -- Batch 3
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
  end if;

  -- The same role booleans as my_work_counts.
  select
    bool_or(m.role_code = 'sales' and authz.holds_active_role('sales', m.legal_entity_id)),
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id))
  into v_sales, v_manager
  from public.memberships m where m.user_id = v_uid and m.status = 'active';
  if not (coalesce(v_sales, false) or coalesce(v_manager, false)) then
    return jsonb_build_object('applies', false);
  end if;

  -- Batch 3 (FP-081): the quotation rows of work_drafts_list (one predicate
  -- source, authz.work_quotation_rows), so the list length equals the count.
  if p_kind in ('quotation_drafts', 'accepted_to_link') then
    select coalesce(jsonb_agg(jsonb_build_object('quotationId', r.quotation_id, 'versionId', r.version_id, 'since', r.since)
                              order by r.since desc, r.quotation_id), '[]'::jsonb)
    into v_page
    from (
      select w.quotation_id, w.version_id, w.since
      from authz.work_quotation_rows() w
      where (case when p_kind = 'quotation_drafts' then w.to_finish else w.accepted_not_linked end)
        and (v_after_since is null or w.since < v_after_since
             or (w.since = v_after_since and w.quotation_id > v_after_deal))
      order by w.since desc, w.quotation_id
      limit v_limit + 1
    ) r;
    v_n := jsonb_array_length(v_page);
    if v_n > v_limit then
      v_last := v_page -> (v_limit - 1);
    end if;
    return jsonb_build_object(
      'applies', true,
      'available', true,
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object('quotationId', q.id, 'versionId', e.x -> 'versionId', 'reference', q.reference,
                   'title', q.title,
                   'subjectKind', case when q.lead_id is not null then 'lead'
                                       when q.referral_draft_id is not null then 'referral' else 'deal' end,
                   'subjectReference', coalesce((select l.reference from public.crm_leads l where l.id = q.lead_id),
                                                (select d.reference from public.deals d where d.id = q.deal_id),
                                                (select rd.reference from public.referral_drafts rd where rd.id = q.referral_draft_id)),
                   'since', e.x -> 'since') order by e.ord)
        from jsonb_array_elements(v_page) with ordinality as e(x, ord)
        join public.quotations q on q.id = (e.x ->> 'quotationId')::uuid
        where e.ord <= v_limit), '[]'::jsonb),
      'hasMore', v_n > v_limit,
      'next', case when v_n > v_limit
                   then jsonb_build_object('since', v_last -> 'since', 'quotationId', v_last -> 'quotationId') end);
  end if;

  if p_kind in ('drafts', 'missing_details') then
    select coalesce(jsonb_agg(jsonb_build_object('dealId', r.deal_id, 'versionNo', r.version_no, 'since', r.since)
                              order by r.since desc, r.deal_id), '[]'::jsonb)
    into v_page
    from (
      select v.deal_id, v.version_no, v.updated_at as since
      from public.booking_versions v
      join public.deals d on d.id = v.deal_id
      where v.status = 'draft' and d.removed_at is null
        and (v_after_since is null or v.updated_at < v_after_since
             or (v.updated_at = v_after_since and v.deal_id > v_after_deal))
        and authz.can_edit_booking_draft(v.deal_id)
        and (p_kind = 'drafts' or cardinality(authz.booking_issues(v.id)) > 0)
      order by v.updated_at desc, v.deal_id
      limit v_limit + 1
    ) r;
  elsif p_kind = 'returned' then
    select coalesce(jsonb_agg(jsonb_build_object('dealId', r.deal_id, 'since', r.since)
                              order by r.since desc, r.deal_id), '[]'::jsonb)
    into v_page
    from (
      select x.deal_id, x.since from (
        select d.id as deal_id, max(coalesce(rv.reviewed_at, rv.updated_at)) as since
        from public.deals d
        join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
        join public.accounts_booking_reviews rv on rv.booking_version_id = v.id and rv.status = 'returned'
        where d.removed_at is null
          and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
               or authz.is_branch_sales_manager(d.id))
        group by d.id
      ) x
      where v_after_since is null or x.since < v_after_since or (x.since = v_after_since and x.deal_id > v_after_deal)
      order by x.since desc, x.deal_id
      limit v_limit + 1
    ) r;
  else
    if not coalesce((select s.intake_prompt_enabled from public.workflow_settings s where s.id), false) then
      return jsonb_build_object('applies', true, 'available', false, 'reason', 'switched_off');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('dealId', r.deal_id, 'since', r.since)
                              order by r.since desc, r.deal_id), '[]'::jsonb)
    into v_page
    from (
      select d.id as deal_id, coalesce(d.source_modified_at, d.created_at) as since
      from public.deals d
      where d.source_system = 'bitrix' and d.removed_at is null
        and authz.deal_in_trigger_stage(d.id)
        and not exists (select 1 from public.booking_versions v where v.deal_id = d.id)
        and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
             or authz.is_branch_sales_manager(d.id))
        and (v_after_since is null or coalesce(d.source_modified_at, d.created_at) < v_after_since
             or (coalesce(d.source_modified_at, d.created_at) = v_after_since and d.id > v_after_deal))
      order by coalesce(d.source_modified_at, d.created_at) desc, d.id
      limit v_limit + 1
    ) r;
  end if;

  v_n := jsonb_array_length(v_page);
  if v_n > v_limit then
    v_last := v_page -> (v_limit - 1);
  end if;
  return jsonb_build_object(
    'applies', true,
    'available', true,
    'rows', coalesce((
      select jsonb_agg(
               jsonb_build_object('dealId', d.id, 'reference', d.reference, 'title', d.title, 'branchId', d.branch_id,
                                  'since', e.x -> 'since')
               || case when p_kind in ('drafts', 'missing_details')
                       then jsonb_build_object('versionNo', e.x -> 'versionNo') else '{}'::jsonb end
               order by e.ord)
      from jsonb_array_elements(v_page) with ordinality as e(x, ord)
      join public.deals d on d.id = (e.x ->> 'dealId')::uuid
      where e.ord <= v_limit), '[]'::jsonb),
    'hasMore', v_n > v_limit,
    'next', case when v_n > v_limit
                 then jsonb_build_object('since', v_last -> 'since', 'dealId', v_last -> 'dealId') end);
end;
$$;

-- ===========================================================================
-- 5. Scoped work sets (one predicate source for the lists and Home)
-- ===========================================================================

-- Every quotation the caller may open today (quotation_get's rule; Deals
-- removed by the sync left out), with its current version (working, else
-- accepted, else sent, else the newest) and the list flags. A closed draft
-- (stored, or due while the switch is on) is never "open", "to finish",
-- "accepted, not linked" or "ready to book". Mercury F1: an accepted referral
-- quotation whose draft already has an active Deal link is "ready to book",
-- not "accepted, not linked". owner_id is the record owner shown in lists
-- (Lead, Deal or draft owner; Mercury F24) and drives "mine".
create function authz.work_quotation_rows()
returns table (quotation_id uuid, version_id uuid, version_no integer, status text, valid_until date, since timestamptz,
  referral_draft_id uuid, draft_closed boolean, never_linked boolean, accepted boolean, converted boolean,
  to_finish boolean, accepted_not_linked boolean, ready_to_book boolean, is_open boolean, mine boolean, owner_id uuid)
language sql stable security definer set search_path = '' as $$
  select x.id, x.cv_id, x.cv_no, x.cv_status, x.cv_valid, x.since, x.referral_draft_id, x.closed, x.never_linked,
    x.accepted, x.converted,
    x.cv_status in ('draft', 'ready') and not x.converted and not x.closed,
    x.accepted and not x.converted and x.no_deal and not x.draft_deal_link and not x.closed,
    x.accepted and not x.converted and (not x.no_deal or x.draft_deal_link) and not x.closed,
    not x.closed and (x.cv_status in ('draft', 'ready', 'sent') or (x.accepted and not x.converted)),
    x.created_by = (select auth.uid()) or x.owner_id is not distinct from (select auth.uid()),
    x.owner_id
  from (
    select q.id, q.referral_draft_id, q.created_by, (cv.vr).id as cv_id, (cv.vr).version_no as cv_no,
      authz.quotation_status(cv.vr) as cv_status, (cv.vr).valid_until as cv_valid,
      greatest(q.updated_at, (cv.vr).updated_at) as since,
      coalesce(q.referral_draft_id is not null and authz.referral_draft_closed(q.referral_draft_id), false) as closed,
      q.referral_draft_id is not null
        and not exists (select 1 from public.referral_draft_links k where k.referral_draft_id = q.referral_draft_id) as never_linked,
      q.referral_draft_id is not null
        and exists (select 1 from public.referral_draft_links k
                    where k.referral_draft_id = q.referral_draft_id and k.ended_at is null and k.deal_id is not null) as draft_deal_link,
      q.accepted_version_id is not null as accepted, q.converted_at is not null as converted,
      q.deal_id is null and q.linked_deal_id is null as no_deal,
      case when q.referral_draft_id is not null then r.owner_user_id
           when q.lead_id is not null then (select l.owner_user_id from public.crm_leads l where l.id = q.lead_id)
           else (select d.owner_user_id from public.deals d where d.id = q.deal_id) end as owner_id
    from public.quotations q
    left join public.referral_drafts r on r.id = q.referral_draft_id
    cross join lateral (
      select v as vr from public.quotation_versions v where v.quotation_id = q.id
      order by (v.status in ('draft', 'ready')) desc, (v.status = 'accepted') desc, (v.status = 'sent') desc, v.version_no desc
      limit 1) cv
    where q.legal_entity_id in (select m.legal_entity_id from public.memberships m
                                where m.user_id = (select auth.uid()) and m.status = 'active')
      and authz.quotation_can_edit(q.id) and not authz.quotation_deal_removed(q.id)
  ) x
$$;

create function authz.work_itinerary_rows()
returns table (document_id uuid, since timestamptz, referral_draft_id uuid, draft_closed boolean, never_linked boolean,
  facts_status text, final_made boolean, is_open boolean, mine boolean)
language sql stable security definer set search_path = '' as $$
  select x.id, x.since, x.rd, x.closed, x.never_linked, x.facts_status, x.final_made,
    not x.closed and not x.final_made, x.mine
  from (
    select d.id, greatest(d.created_at, f.updated_at) as since, coalesce(d.referral_draft_id, q.referral_draft_id) as rd,
      coalesce(coalesce(d.referral_draft_id, q.referral_draft_id) is not null
               and authz.referral_draft_closed(coalesce(d.referral_draft_id, q.referral_draft_id)), false) as closed,
      coalesce(d.referral_draft_id, q.referral_draft_id) is not null
        and not exists (select 1 from public.referral_draft_links k
                        where k.referral_draft_id = coalesce(d.referral_draft_id, q.referral_draft_id)) as never_linked,
      f.status as facts_status,
      exists (select 1 from public.itinerary_rendered_documents rr where rr.document_id = d.id and rr.kind = 'final') as final_made,
      coalesce(d.created_by = (select auth.uid()) or q.owner_user_id = (select auth.uid())
               or r.owner_user_id = (select auth.uid()), false) as mine
    from public.itinerary_documents d
    join public.itinerary_fact_drafts f on f.document_id = d.id
    left join public.quotations q on q.id = d.quotation_id
    left join public.referral_drafts r on r.id = coalesce(d.referral_draft_id, q.referral_draft_id)
    where d.legal_entity_id in (select m.legal_entity_id from public.memberships m
                                where m.user_id = (select auth.uid()) and m.status = 'active')
      and authz.itinerary_can_edit(d.id)
      and not exists (select 1 from public.deals dd where dd.id = authz.itinerary_deal(d.id) and dd.removed_at is not null)
  ) x
$$;

-- ===========================================================================
-- 6. Commands
-- ===========================================================================

-- Shared body of the two standalone create commands: authorization, replay,
-- switch, validation, the draft row. Returns the draft and whether it is new.
create function authz.referral_draft_start(p_branch_id uuid, p_customer jsonb, p_title text, p_request_id uuid, p_via text,
  out o_draft public.referral_drafts, out o_created boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_bad text[];
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_entity uuid;
  v_no integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_branch_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  if not authz.referral_branch_creator(p_branch_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into o_draft from public.referral_drafts r where r.created_by = (select auth.uid()) and r.request_id = p_request_id;
  if o_draft.id is not null then
    if o_draft.branch_id is distinct from p_branch_id or o_draft.created_via is distinct from p_via
       or o_draft.customer_name is distinct from authz.b11_text(p_customer -> 'customerName') then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    o_created := false;
    return;
  end if;
  -- F.3.1: no new draft while the switch is off (existing drafts keep working).
  if not authz.referral_drafts_enabled() then
    raise exception 'referral_drafts_disabled' using errcode = '55000';
  end if;
  v_bad := authz.referral_customer_bad(p_customer, true);
  if length(v_title) not between 1 and 200 then
    v_bad := v_bad || 'title'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  select b.legal_entity_id into v_entity from public.branches b where b.id = p_branch_id;
  begin
    insert into public.referral_draft_counters as c (legal_entity_id, last_no) values (v_entity, 1)
    on conflict (legal_entity_id) do update set last_no = c.last_no + 1
    returning c.last_no into v_no;
    insert into public.referral_drafts (legal_entity_id, branch_id, draft_no, reference, owner_user_id, customer_name, mobile, email,
      company_name, source_kind, source_note, created_via, request_id, created_by)
    values (v_entity, p_branch_id, v_no, 'TD-' || v_no::text, (select auth.uid()), authz.b11_text(p_customer -> 'customerName'),
      authz.b11_text(p_customer -> 'mobile'), authz.b11_text(p_customer -> 'email'), authz.b11_text(p_customer -> 'companyName'),
      authz.b11_text(p_customer -> 'sourceKind'), authz.b11_text(p_customer -> 'sourceNote'), p_via, p_request_id,
      (select auth.uid()))
    returning * into o_draft;
  exception when unique_violation then
    -- Echo-A L5: the same request committed by a concurrent call: answer as its replay.
    select * into o_draft from public.referral_drafts r where r.created_by = (select auth.uid()) and r.request_id = p_request_id;
    if o_draft.id is null or o_draft.branch_id is distinct from p_branch_id or o_draft.created_via is distinct from p_via
       or o_draft.customer_name is distinct from authz.b11_text(p_customer -> 'customerName') then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    o_created := false;
    return;
  end;
  perform authz.write_audit('referral.draft_created', v_entity, p_branch_id, 'referral_draft', o_draft.id, null,
    jsonb_build_object('reference', o_draft.reference, 'createdVia', p_via, 'sourceKind', o_draft.source_kind));
  o_created := true;
end;
$$;

-- Duplicate hint (DA-57): open drafts the caller can already open with the
-- same mobile. References only; never refuses.
create function authz.referral_duplicates(p_draft uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('reference', o.reference) order by o.created_at desc)
    from (select o.* from public.referral_drafts o join public.referral_drafts r on r.id = p_draft
          where o.id <> r.id and o.legal_entity_id = r.legal_entity_id and r.mobile is not null and o.mobile = r.mobile
            and authz.referral_draft_state(o.id) ->> 'status' = 'open'  -- Echo-A L6: effective state
            and authz.referral_draft_can_edit(o.id)
          order by o.created_at desc limit 5) o), '[]'::jsonb)
$$;

create function public.quotation_create_standalone(p_branch_id uuid, p_customer jsonb, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start record;
  v_res jsonb;
  v_ver uuid;
  v_q public.quotations%rowtype;
begin
  select * into v_start from authz.referral_draft_start(p_branch_id, p_customer, p_title, p_request_id, 'quotation');
  if not v_start.o_created then
    select * into v_q from public.quotations q
    where q.referral_draft_id = (v_start.o_draft).id and q.created_by = (select auth.uid()) and q.request_id = p_request_id;
    if v_q.id is null or v_q.title is distinct from btrim(coalesce(p_title, ''), E' \t\r\n') then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
      'quotationId', v_q.id, 'reference', v_q.reference,
      'versionId', (select v.id from public.quotation_versions v where v.quotation_id = v_q.id and v.version_no = 1),
      'versionNo', 1,
      'rowVersion', (select v.row_version from public.quotation_versions v where v.quotation_id = v_q.id and v.version_no = 1),
      'created', false, 'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
  end if;
  v_res := public.quotation_create('referral', (v_start.o_draft).id, p_title, p_request_id);
  v_ver := (v_res ->> 'versionId')::uuid;
  -- Values staff typed at creation are staff writes (the contacts watcher
  -- records them in the value-free history, F.1.1).
  if (v_start.o_draft).mobile is not null or (v_start.o_draft).email is not null then
    insert into public.quotation_version_contacts (quotation_version_id, legal_entity_id, contact_name, mobile, email, company_name,
      updated_by)
    values (v_ver, (v_start.o_draft).legal_entity_id, (v_start.o_draft).customer_name, (v_start.o_draft).mobile,
      (v_start.o_draft).email, (v_start.o_draft).company_name, (select auth.uid()));
  end if;
  return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
    'quotationId', v_res -> 'quotationId', 'reference', v_res -> 'reference', 'versionId', v_ver, 'versionNo', 1,
    'rowVersion', v_res -> 'rowVersion', 'created', true,
    'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
end;
$$;

create function public.itinerary_create_standalone(p_branch_id uuid, p_customer jsonb, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start record;
  v_res jsonb;
  v_doc public.itinerary_documents%rowtype;
begin
  select * into v_start from authz.referral_draft_start(p_branch_id, p_customer, p_title, p_request_id, 'itinerary');
  if not v_start.o_created then
    select * into v_doc from public.itinerary_documents d
    where d.referral_draft_id = (v_start.o_draft).id and d.created_by = (select auth.uid()) and d.request_id = p_request_id;
    if v_doc.id is null or v_doc.title is distinct from btrim(coalesce(p_title, ''), E' \t\r\n') then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
      'documentId', v_doc.id, 'draftId', (select f.id from public.itinerary_fact_drafts f where f.document_id = v_doc.id),
      'rowVersion', (select f.row_version from public.itinerary_fact_drafts f where f.document_id = v_doc.id),
      'created', false, 'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
  end if;
  v_res := public.itinerary_document_create('referral', (v_start.o_draft).id, p_title, p_request_id);
  return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
    'documentId', v_res -> 'documentId', 'draftId', v_res -> 'draftId', 'rowVersion', v_res -> 'rowVersion', 'created', true,
    'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
end;
$$;

-- Partial save of the draft's own fields (sent quotation versions never change).
create function public.referral_draft_save(p_draft_id uuid, p_expected_row_version integer, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.referral_drafts%rowtype;
  v_bad text[];
  v_changed text[] := '{}'::text[];
  v_key text;
  v_cols constant jsonb := jsonb_build_object('customerName', 'customer_name', 'mobile', 'mobile', 'email', 'email',
    'companyName', 'company_name', 'sourceKind', 'source_kind', 'sourceNote', 'source_note');
begin
  if p_draft_id is null or not authz.referral_draft_can_edit(p_draft_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  r := authz.referral_draft_lock_write(p_draft_id);
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.referral_customer_bad(p_fields, false);
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if authz.b11_text(p_fields -> v_key) is distinct from (to_jsonb(r) ->> (v_cols ->> v_key)) then
      v_changed := v_changed || v_key;
    end if;
  end loop;
  update public.referral_drafts d set
    customer_name = case when p_fields ? 'customerName' then authz.b11_text(p_fields -> 'customerName') else d.customer_name end,
    mobile = case when p_fields ? 'mobile' then authz.b11_text(p_fields -> 'mobile') else d.mobile end,
    email = case when p_fields ? 'email' then authz.b11_text(p_fields -> 'email') else d.email end,
    company_name = case when p_fields ? 'companyName' then authz.b11_text(p_fields -> 'companyName') else d.company_name end,
    source_kind = case when p_fields ? 'sourceKind' then authz.b11_text(p_fields -> 'sourceKind') else d.source_kind end,
    source_note = case when p_fields ? 'sourceNote' then authz.b11_text(p_fields -> 'sourceNote') else d.source_note end,
    row_version = d.row_version + 1, updated_at = now()
  where d.id = r.id returning * into r;
  perform authz.write_audit('referral.draft_saved', r.legal_entity_id, r.branch_id, 'referral_draft', r.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'rowVersion', r.row_version));
  return jsonb_build_object('rowVersion', r.row_version, 'changedFields', to_jsonb(v_changed));
end;
$$;

-- Manual close (owner or Manager). F.3.3: on a due draft it persists the
-- automatic closure and reports it; it never overwrites a closure reason.
create function public.referral_draft_close(p_draft_id uuid, p_expected_row_version integer, p_reason text, p_note text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.referral_drafts%rowtype;
  v_note text;
begin
  if p_draft_id is null or not authz.referral_draft_owner_or_manager(p_draft_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into r from public.referral_drafts d where d.id = p_draft_id for update;
  if r.status = 'closed' then
    return jsonb_build_object('status', 'closed', 'closedReason', r.closed_reason, 'alreadyClosed', true,
      'rowVersion', r.row_version);
  end if;
  if authz.referral_draft_due(r.id) then
    perform authz.referral_draft_persist_auto_close(r.id);
    return jsonb_build_object('status', 'closed', 'closedReason', 'no_activity', 'alreadyClosed', true,
      'rowVersion', r.row_version + 1);
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  if p_reason is null or p_reason not in ('duplicate', 'lost', 'handled_elsewhere', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_note := authz.referral_note(p_note, 0, 500, 'note');
  update public.referral_drafts d
  set status = 'closed', closed_reason = p_reason, closed_at = now(), closed_by = (select auth.uid()), close_note = v_note,
      row_version = d.row_version + 1, updated_at = now()
  where d.id = r.id returning * into r;
  perform authz.write_audit('referral.draft_closed', r.legal_entity_id, r.branch_id, 'referral_draft', r.id, v_note,
    jsonb_build_object('automatic', false, 'reason', p_reason));
  return jsonb_build_object('status', 'closed', 'closedReason', p_reason, 'alreadyClosed', false, 'rowVersion', r.row_version);
end;
$$;

-- Reopen (owner or Manager). F.3.3: a due, stored-open draft gets its
-- automatic closure and the reopening in this one transaction.
create function public.referral_draft_reopen(p_draft_id uuid, p_expected_row_version integer, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.referral_drafts%rowtype;
  v_note text;
  v_due date;
  v_previous text;
  v_auto boolean;
begin
  if p_draft_id is null or not authz.referral_draft_owner_or_manager(p_draft_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into r from public.referral_drafts d where d.id = p_draft_id for update;
  if r.status = 'open' and not authz.referral_draft_due(r.id) then
    raise exception 'draft_not_closed' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  v_previous := coalesce(r.closed_reason, 'no_activity');
  v_note := authz.referral_note(p_note, case when v_previous = 'duplicate' then 1 else 0 end, 500, 'note');
  if r.status = 'open' then
    v_due := authz.referral_draft_persist_auto_close(r.id);
  else
    v_due := r.closed_due_on;
  end if;
  v_auto := v_previous = 'no_activity';
  update public.referral_drafts d
  set status = 'open', closed_reason = null, closed_at = null, closed_by = null, close_note = null, closed_due_on = null,
      last_activity_at = now(), row_version = d.row_version + 1, updated_at = now()
  where d.id = r.id returning * into r;
  perform authz.write_audit('referral.draft_reopened', r.legal_entity_id, r.branch_id, 'referral_draft', r.id, v_note,
    jsonb_build_object('previousReason', v_previous, 'closedAutomatically', v_auto)
    || case when v_auto then jsonb_build_object('dueOn', to_char(v_due, 'YYYY-MM-DD')) else '{}'::jsonb end);
  return jsonb_build_object('status', 'open', 'closedAutomatically', v_auto,
    'dueOn', case when v_auto then to_char(v_due, 'YYYY-MM-DD') end,
    'autoClose', authz.referral_draft_state(r.id) -> 'autoClose', 'rowVersion', r.row_version);
end;
$$;

-- Branch Manager only; the new owner works in Sales in the draft's branch.
create function public.referral_draft_reassign(p_draft_id uuid, p_expected_row_version integer, p_new_owner uuid, p_reason text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.referral_drafts%rowtype;
  v_reason text;
  v_from uuid;
begin
  if p_draft_id is null or not authz.referral_draft_is_manager(p_draft_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  r := authz.referral_draft_lock_write(p_draft_id);
  -- Echo-A L1: the idempotent answer comes before the row-version check.
  if p_new_owner is not null and p_new_owner = r.owner_user_id then
    return jsonb_build_object('ownerIsYou', r.owner_user_id = (select auth.uid()), 'changed', false, 'rowVersion', r.row_version);
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  v_reason := authz.referral_note(p_reason, 10, 500, 'reason');
  if p_new_owner is null or p_new_owner = (select auth.uid()) or not exists (
       select 1 from public.memberships m
       join public.legal_entities e on e.id = m.legal_entity_id
       join public.branches b on b.id = m.branch_id
       where m.user_id = p_new_owner and m.legal_entity_id = r.legal_entity_id and m.branch_id = r.branch_id
         and m.role_code = 'sales' and m.status = 'active' and e.status = 'enabled' and b.status = 'enabled')
     or exists (select 1 from public.memberships p where p.user_id = p_new_owner and p.legal_entity_id = r.legal_entity_id
                and p.role_code = 'purchase' and p.status = 'active') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'newOwner';
  end if;
  v_from := r.owner_user_id;
  update public.referral_drafts d set owner_user_id = p_new_owner, row_version = d.row_version + 1, updated_at = now()
  where d.id = r.id returning * into r;
  perform authz.write_audit('referral.draft_reassigned', r.legal_entity_id, r.branch_id, 'referral_draft', r.id, v_reason,
    jsonb_build_object('fromOwner', v_from, 'toOwner', p_new_owner));
  return jsonb_build_object('ownerIsYou', false, 'changed', true, 'rowVersion', r.row_version);
end;
$$;

-- Explicit link to a Lead or Deal the caller can also edit (B.4, B.5). Never
-- by matching name, mobile or e-mail; writes no field (F.1.3); never touches
-- Bitrix, bookings, tasks or money. Lock order draft -> Deal.
create function public.referral_draft_link(p_draft_id uuid, p_expected_row_version integer, p_target_kind text,
  p_target_id uuid, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.referral_drafts%rowtype;
  v_note text;
  v_existing public.referral_draft_links%rowtype;
  v_deal public.deals%rowtype;
  v_lead public.crm_leads%rowtype;
  v_link_lead public.crm_leads%rowtype;
  v_id uuid;
begin
  if p_draft_id is null or not authz.referral_draft_can_edit(p_draft_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_target_kind is null or p_target_kind not in ('lead', 'deal') or p_target_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'target';
  end if;
  if p_target_kind = 'deal' then
    if exists (select 1 from public.deals d where d.id = p_target_id and d.removed_at is not null
               and authz.is_entity_member(d.legal_entity_id)) then
      raise exception 'deal_removed' using errcode = '55000';
    end if;
    if not authz.can_edit_booking_draft(p_target_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not authz.quotation_lead_editor(p_target_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  r := authz.referral_draft_lock_write(p_draft_id);
  -- Echo-A L1: the idempotent answer comes before the row-version check.
  select * into v_existing from public.referral_draft_links k
  where k.referral_draft_id = r.id and k.target_kind = p_target_kind and k.ended_at is null;
  if v_existing.id is not null and coalesce(v_existing.deal_id, v_existing.lead_id) = p_target_id then
    return jsonb_build_object('linkId', v_existing.id, 'targetKind', p_target_kind, 'targetId', p_target_id,
      'rowVersion', r.row_version, 'existing', true);
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  v_note := authz.referral_note(p_note, 0, 500, 'note');
  if v_existing.id is not null then
    raise exception 'draft_already_linked' using errcode = '55000';
  end if;
  if p_target_kind = 'deal' then
    select * into v_deal from public.deals d where d.id = p_target_id for no key update;
    if v_deal.removed_at is not null then
      raise exception 'deal_removed' using errcode = '55000';
    end if;
    if v_deal.legal_entity_id <> r.legal_entity_id or v_deal.branch_id <> r.branch_id then
      raise exception 'branch_mismatch' using errcode = '22023';
    end if;
    if authz.deal_not_active(v_deal.id) then
      raise exception 'deal_not_active' using errcode = '55000';
    end if;
    select l.* into v_link_lead from public.referral_draft_links k join public.crm_leads l on l.id = k.lead_id
    where k.referral_draft_id = r.id and k.ended_at is null and k.lead_id is not null;
    if v_link_lead.id is not null and (v_deal.source_lead_id is null or v_deal.source_lead_id is distinct from v_link_lead.source_lead_id
                                       or v_deal.source_portal is distinct from v_link_lead.source_portal) then
      raise exception 'deal_not_from_lead' using errcode = '22023';
    end if;
    if exists (select 1 from public.quotations q where q.referral_draft_id = r.id and q.accepted_version_id is not null)
       and exists (select 1 from public.quotations o
                   where o.linked_deal_id = v_deal.id or (o.deal_id = v_deal.id and o.accepted_version_id is not null)) then
      raise exception 'deal_already_linked' using errcode = '55000';
    end if;
  else
    select * into v_lead from public.crm_leads l where l.id = p_target_id;
    if v_lead.legal_entity_id <> r.legal_entity_id or v_lead.branch_id <> r.branch_id then
      raise exception 'branch_mismatch' using errcode = '22023';
    end if;
  end if;
  insert into public.referral_draft_links (referral_draft_id, legal_entity_id, target_kind, lead_id, deal_id, linked_by, link_note)
  values (r.id, r.legal_entity_id, p_target_kind, case when p_target_kind = 'lead' then p_target_id end,
    case when p_target_kind = 'deal' then p_target_id end, (select auth.uid()), v_note)
  returning id into v_id;
  update public.referral_drafts d set row_version = d.row_version + 1, updated_at = now() where d.id = r.id returning * into r;
  perform authz.write_audit('referral.draft_linked', r.legal_entity_id, r.branch_id, 'referral_draft', r.id, null,
    jsonb_build_object('linkId', v_id, 'targetKind', p_target_kind, 'targetId', p_target_id));
  return jsonb_build_object('linkId', v_id, 'targetKind', p_target_kind, 'targetId', p_target_id, 'rowVersion', r.row_version,
    'existing', false);
end;
$$;

-- Wrong-link correction (A4): owner or branch Manager, with a reason, until a
-- quotation of the draft is bound or converted (link_locked). History kept;
-- access computed from active links ends at once. Lead ruling 21 Oct (Q1):
-- also on a CLOSED draft (removing exposure never requires reopening); it
-- neither reopens the draft nor counts as activity.
create function public.referral_draft_unlink(p_link_id uuid, p_expected_row_version integer, p_reason text, p_note text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  k public.referral_draft_links%rowtype;
  r public.referral_drafts%rowtype;
  v_note text;
begin
  select * into k from public.referral_draft_links l where l.id = p_link_id;
  if k.id is null or not authz.referral_draft_owner_or_manager(k.referral_draft_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Lead ruling Q1: lock the draft row directly (no draft_closed refusal, no activity).
  select * into r from public.referral_drafts d where d.id = k.referral_draft_id for update;
  select * into k from public.referral_draft_links l where l.id = p_link_id for update;
  -- Echo-A L1: the idempotent answer comes before the row-version check.
  if k.ended_at is not null then
    return jsonb_build_object('linkId', k.id, 'ended', true, 'rowVersion', r.row_version);
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  if p_reason is null or p_reason not in ('wrong_link', 'duplicate', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_note := authz.referral_note(p_note, 10, 500, 'note');
  if authz.referral_draft_bound(r.id) then
    raise exception 'link_locked' using errcode = '55000';
  end if;
  update public.referral_draft_links l
  set ended_by = (select auth.uid()), ended_at = now(), end_reason = p_reason, end_note = v_note
  where l.id = k.id;
  update public.referral_drafts d set row_version = d.row_version + 1, updated_at = now() where d.id = r.id returning * into r;
  perform authz.write_audit('referral.draft_unlinked', r.legal_entity_id, r.branch_id, 'referral_draft', r.id, v_note,
    jsonb_build_object('linkId', k.id, 'targetKind', k.target_kind, 'targetId', coalesce(k.deal_id, k.lead_id),
      'reason', p_reason));
  return jsonb_build_object('linkId', k.id, 'ended', true, 'rowVersion', r.row_version);
end;
$$;

-- B.9 / F.3.3 automatic close (service_role only; batch 1-200; idempotent).
-- Holds the settings row FOR SHARE, so a concurrent switch change waits for
-- the batch (admin_set_workflow_setting answers settings_busy after 5 s).
create function public.referral_drafts_close_inactive(p_limit integer default 100) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_limit integer := coalesce(p_limit, 100);
  v_on boolean;
  v_closed integer := 0;
  v_id uuid;
begin
  if v_limit not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  select s.referral_drafts into v_on from public.workflow_settings s where s.id for share;
  if not coalesce(v_on, false) then
    return jsonb_build_object('closed', 0, 'skipped', 'switch_off');
  end if;
  for v_id in
    select d.id from public.referral_drafts d
    where d.status = 'open' and authz.finance_today() >= authz.referral_due_on(d.last_activity_at)
      -- Echo-A M1: bound or converted drafts never close, so they never take a batch slot.
      and not exists (select 1 from public.quotations q
                      where q.referral_draft_id = d.id and (q.linked_deal_id is not null or q.converted_at is not null))
    order by d.last_activity_at, d.id
    limit v_limit
    for update skip locked
  loop
    -- Re-check under the lock in a fresh statement (activity may have
    -- committed meanwhile; bound drafts never close).
    if authz.referral_draft_due(v_id) then
      perform authz.referral_draft_persist_auto_close(v_id);
      v_closed := v_closed + 1;
    end if;
  end loop;
  return jsonb_build_object('closed', v_closed, 'skipped', null);
end;
$$;

-- Scheduler provisioning: owner SQL only, never automatic. Creates the daily
-- job PAUSED (00:20 IST); activated only inside the owner's APPROVAL NEEDED
-- for the referral_drafts switch: cron.alter_job(jobid, active := true).
create function authz.provision_referral_close_job() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id bigint;
  v_result jsonb;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed' using errcode = '55000';
  end if;
  execute 'select j.jobid from cron.job j where j.jobname = $1' into v_id using 'referral-drafts-close-inactive';
  if v_id is null then
    execute 'select cron.schedule($1, $2, $3)' into v_id
      using 'referral-drafts-close-inactive', '50 18 * * *', 'select public.referral_drafts_close_inactive(200)';
    execute 'select cron.alter_job($1, active := false)' using v_id;
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active)), '[]'::jsonb)
    from cron.job j where j.jobname = 'referral-drafts-close-inactive'
  $q$ into v_result;
  return v_result;
end;
$$;

-- ===========================================================================
-- 7. Reads (definer, stable; reads never write)
-- ===========================================================================

create function public.work_drafts_list(p_kind text, p_filter jsonb, p_after jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_limit integer := coalesce(p_limit, 25);
  v_status text;
  v_scope text := 'mine';
  v_ref text;
  v_after_since timestamptz;
  v_after_id uuid;
  v_applies boolean;
  v_counts jsonb;
  v_page jsonb;
  v_n integer;
  v_last jsonb;
  v_rows jsonb;
  v_total integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('quotations', 'itineraries') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  v_status := 'open';
  if v_limit not between 1 and 50 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_filter is not null and jsonb_typeof(p_filter) <> 'null' then
    if jsonb_typeof(p_filter) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_filter) k where k not in ('status', 'scope', 'reference')) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
    end if;
    if p_filter ? 'status' and jsonb_typeof(p_filter -> 'status') <> 'null' then
      v_status := case when jsonb_typeof(p_filter -> 'status') = 'string' then p_filter ->> 'status' end;
      if v_status is null
         or (p_kind = 'quotations' and v_status not in ('open', 'to_finish', 'drafts', 'ready', 'shared', 'accepted',
                                                        'accepted_not_linked', 'ready_to_book', 'declined_or_expired', 'closed_drafts', 'all'))
         or (p_kind = 'itineraries' and v_status not in ('open', 'draft', 'ready', 'final_made', 'closed_drafts', 'all')) then
        raise exception 'invalid_input' using errcode = '22023', hint = 'status';
      end if;
    end if;
    if p_filter ? 'scope' and jsonb_typeof(p_filter -> 'scope') <> 'null' then
      v_scope := case when jsonb_typeof(p_filter -> 'scope') = 'string' then p_filter ->> 'scope' end;
      if v_scope is null or v_scope not in ('mine', 'all') then
        raise exception 'invalid_input' using errcode = '22023', hint = 'scope';
      end if;
    end if;
    if p_filter ? 'reference' and jsonb_typeof(p_filter -> 'reference') <> 'null' then
      v_ref := upper(btrim(case when jsonb_typeof(p_filter -> 'reference') = 'string' then p_filter ->> 'reference' end));
      if v_ref is null or v_ref !~ '^T[QD]-[1-9][0-9]{0,8}$' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'reference';
      end if;
    end if;
  end if;
  if p_after is not null and jsonb_typeof(p_after) <> 'null' then
    begin
      if jsonb_typeof(p_after) <> 'object' or jsonb_typeof(p_after -> 'since') is distinct from 'string'
         or jsonb_typeof(p_after -> 'id') is distinct from 'string'
         or exists (select 1 from jsonb_object_keys(p_after) k where k not in ('since', 'id')) then
        raise exception 'bad cursor';
      end if;
      v_after_since := (p_after ->> 'since')::timestamptz;
      v_after_id := (p_after ->> 'id')::uuid;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
  end if;

  -- Same role rule as my_work_list: active Sales or Manager somewhere.
  select coalesce(bool_or((m.role_code = 'sales' and authz.holds_active_role('sales', m.legal_entity_id))
                          or (m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id))), false)
  into v_applies
  from public.memberships m where m.user_id = v_uid and m.status = 'active';
  if not v_applies then
    return jsonb_build_object('applies', false);
  end if;

  -- Echo-A L3: one scan of the work set per page; the page rows are built from
  -- the same materialized set as the counts. Echo-A L4 / Mercury F24: the
  -- owner shown is the record owner (Lead, Deal or draft); a name only when the
  -- viewer can read that Lead / Deal (DEC-52), or for a draft the owner or the
  -- branch Manager; ownerIsYou compares the same owner.
  if p_kind = 'quotations' then
    with w as materialized (
      select x.*, (x.draft_closed and x.never_linked) as hidden from authz.work_quotation_rows() x
      where v_ref is not null or v_scope = 'all' or x.mine
    ), m as (
      select w.* from w
      where case when v_ref is not null then exists (
                   select 1 from public.quotations q left join public.referral_drafts r on r.id = q.referral_draft_id
                   where q.id = w.quotation_id and (q.reference = v_ref or r.reference = v_ref))
                 else case v_status
                   when 'open' then w.is_open
                   when 'to_finish' then w.to_finish
                   when 'drafts' then w.status = 'draft' and not w.hidden
                   when 'ready' then w.status = 'ready' and not w.hidden
                   when 'shared' then w.status = 'sent' and not w.hidden
                   when 'accepted' then w.accepted and not w.hidden
                   when 'accepted_not_linked' then w.accepted_not_linked
                   when 'ready_to_book' then w.ready_to_book
                   when 'declined_or_expired' then w.status in ('declined', 'expired') and not w.hidden
                   when 'closed_drafts' then w.draft_closed
                   else not w.hidden end end
    ), p as (
      select m.* from m
      where v_after_since is null or m.since < v_after_since or (m.since = v_after_since and m.quotation_id > v_after_id)
      order by m.since desc, m.quotation_id limit v_limit + 1
    )
    select
      (select jsonb_build_object(
         'open', count(*) filter (where w.is_open),
         'to_finish', count(*) filter (where w.to_finish),
         'drafts', count(*) filter (where w.status = 'draft' and not w.hidden),
         'ready', count(*) filter (where w.status = 'ready' and not w.hidden),
         'shared', count(*) filter (where w.status = 'sent' and not w.hidden),
         'accepted', count(*) filter (where w.accepted and not w.hidden),
         'accepted_not_linked', count(*) filter (where w.accepted_not_linked),
         'ready_to_book', count(*) filter (where w.ready_to_book),
         'declined_or_expired', count(*) filter (where w.status in ('declined', 'expired') and not w.hidden),
         'closed_drafts', count(*) filter (where w.draft_closed),
         'all', count(*) filter (where not w.hidden)) from w where v_scope = 'all' or w.mine),
      (select count(*) from m),
      (select coalesce(jsonb_agg(
        jsonb_build_object(
          'quotationId', q.id, 'reference', q.reference, 'title', q.title,
          'subjectKind', case when q.lead_id is not null then 'lead' when q.referral_draft_id is not null then 'referral' else 'deal' end,
          'subject', case
            when q.lead_id is not null then (select jsonb_build_object('kind', 'lead', 'id', l.id, 'reference', l.reference, 'title', l.title)
                                             from public.crm_leads l where l.id = q.lead_id)
            when q.deal_id is not null then (select jsonb_build_object('kind', 'deal', 'id', d.id, 'reference', d.reference, 'title', d.title)
                                             from public.deals d where d.id = q.deal_id)
            else (select jsonb_build_object('kind', 'referral', 'id', r.id, 'reference', r.reference, 'title', r.customer_name)
                  from public.referral_drafts r where r.id = q.referral_draft_id) end,
          'referralDraftId', q.referral_draft_id,
          'draft', case when q.referral_draft_id is not null
                        then authz.referral_draft_state(q.referral_draft_id)
                             || jsonb_build_object('reference', (select r.reference from public.referral_drafts r where r.id = q.referral_draft_id)) end,
          'draftLink', case when q.referral_draft_id is not null then authz.referral_active_link(q.referral_draft_id) end,
          'linkedDealId', q.linked_deal_id,
          'currentVersion', jsonb_build_object('versionId', p.version_id, 'versionNo', p.version_no, 'status', p.status,
                                               'validUntil', to_char(p.valid_until, 'YYYY-MM-DD')),
          'accepted', p.accepted, 'converted', p.converted, 'acceptedNotLinked', p.accepted_not_linked,
          'readyToBook', p.ready_to_book,
          'customerName', coalesce((select c.contact_name from public.quotation_version_contacts c where c.quotation_version_id = p.version_id),
                                   (select r.customer_name from public.referral_drafts r where r.id = q.referral_draft_id)),
          'destination', (select v.trip_destination from public.quotation_versions v where v.id = p.version_id),
          'tripStart', (select to_char(v.trip_start, 'YYYY-MM-DD') from public.quotation_versions v where v.id = p.version_id),
          'ownerName', case when q.referral_draft_id is not null then authz.referral_owner_name(q.referral_draft_id)
                            when q.lead_id is not null and authz.can_read_lead(q.lead_id)
                              then (select s.display_name from public.staff_profiles s where s.user_id = p.owner_id)
                            when q.deal_id is not null and authz.can_read_deal(q.deal_id)
                              then (select s.display_name from public.staff_profiles s where s.user_id = p.owner_id) end,
          'ownerIsYou', coalesce(p.owner_id = v_uid, false),
          'since', p.since)
        order by p.since desc, p.quotation_id), '[]'::jsonb)
       from p join public.quotations q on q.id = p.quotation_id)
    into v_counts, v_total, v_page;
  else
    with w as materialized (
      select x.*, (x.draft_closed and x.never_linked) as hidden from authz.work_itinerary_rows() x
      where v_ref is not null or v_scope = 'all' or x.mine
    ), m as (
      select w.* from w
      where case when v_ref is not null then exists (
                   select 1 from public.itinerary_documents d
                   left join public.quotations q on q.id = d.quotation_id
                   left join public.referral_drafts r on r.id = w.referral_draft_id
                   where d.id = w.document_id and (q.reference = v_ref or r.reference = v_ref))
                 else case v_status
                   when 'open' then w.is_open
                   when 'draft' then w.facts_status = 'draft' and not w.hidden
                   when 'ready' then w.facts_status = 'ready' and not w.hidden
                   when 'final_made' then w.final_made and not w.hidden
                   when 'closed_drafts' then w.draft_closed
                   else not w.hidden end end
    ), p as (
      select m.* from m
      where v_after_since is null or m.since < v_after_since or (m.since = v_after_since and m.document_id > v_after_id)
      order by m.since desc, m.document_id limit v_limit + 1
    )
    select
      (select jsonb_build_object(
         'open', count(*) filter (where w.is_open),
         'draft', count(*) filter (where w.facts_status = 'draft' and not w.hidden),
         'ready', count(*) filter (where w.facts_status = 'ready' and not w.hidden),
         'final_made', count(*) filter (where w.final_made and not w.hidden),
         'closed_drafts', count(*) filter (where w.draft_closed),
         'all', count(*) filter (where not w.hidden)) from w where v_scope = 'all' or w.mine),
      (select count(*) from m),
      (select coalesce(jsonb_agg(
        jsonb_build_object(
          'documentId', d.id, 'title', d.title,
          'subjectKind', case when d.quotation_id is not null then 'quotation' when d.referral_draft_id is not null then 'referral'
                              else 'deal' end,
          'subject', case
            when d.quotation_id is not null then (select jsonb_build_object('kind', 'quotation', 'id', q.id, 'reference', q.reference,
                                                                            'title', q.title)
                                                  from public.quotations q where q.id = d.quotation_id)
            when d.deal_id is not null then (select jsonb_build_object('kind', 'deal', 'id', dl.id, 'reference', dl.reference, 'title', dl.title)
                                             from public.deals dl where dl.id = d.deal_id)
            else (select jsonb_build_object('kind', 'referral', 'id', r.id, 'reference', r.reference, 'title', r.customer_name)
                  from public.referral_drafts r where r.id = d.referral_draft_id) end,
          'quotationId', d.quotation_id,
          'referralDraftId', p.referral_draft_id,
          'draft', case when p.referral_draft_id is not null
                        then authz.referral_draft_state(p.referral_draft_id)
                             || jsonb_build_object('reference', (select r.reference from public.referral_drafts r where r.id = p.referral_draft_id)) end,
          'draftLink', case when p.referral_draft_id is not null then authz.referral_active_link(p.referral_draft_id) end,
          'basisKind', authz.itinerary_basis(d.id) ->> 'kind',
          'factsStatus', p.facts_status,
          'latestFinal', (select jsonb_build_object('renderedId', rr.id, 'createdAt', rr.created_at)
                          from public.itinerary_rendered_documents rr where rr.document_id = d.id and rr.kind = 'final'
                          order by rr.created_at desc limit 1),
          'openDifferences', coalesce((select count(*) from public.itinerary_fact_differences x
                                       where x.run_id = (select (authz.itinerary_current_run(f.id)).id) and x.acknowledged_at is null), 0),
          'ownerName', case when p.referral_draft_id is not null then authz.referral_owner_name(p.referral_draft_id)
                            when d.quotation_id is not null then (
                              select s.display_name from public.quotations q
                              join public.staff_profiles s
                                on s.user_id = case when q.lead_id is not null and authz.can_read_lead(q.lead_id)
                                                      then (select l.owner_user_id from public.crm_leads l where l.id = q.lead_id)
                                                    when q.deal_id is not null and authz.can_read_deal(q.deal_id)
                                                      then (select dd.owner_user_id from public.deals dd where dd.id = q.deal_id) end
                              where q.id = d.quotation_id)
                            when authz.can_read_deal(d.deal_id) then (
                              select s.display_name from public.deals dd join public.staff_profiles s on s.user_id = dd.owner_user_id
                              where dd.id = d.deal_id) end,
          -- Echo L9: the same owner as the name above (draft, else the quotation's Lead / Deal, else the Deal).
          'ownerIsYou', coalesce(case
            when p.referral_draft_id is not null then (select r.owner_user_id from public.referral_drafts r where r.id = p.referral_draft_id)
            when d.quotation_id is not null then (
              select coalesce((select l.owner_user_id from public.crm_leads l where l.id = q.lead_id),
                              (select dd.owner_user_id from public.deals dd where dd.id = q.deal_id))
              from public.quotations q where q.id = d.quotation_id)
            else (select dd.owner_user_id from public.deals dd where dd.id = d.deal_id) end = v_uid, false),
          'createdByYou', d.created_by = v_uid,
          'since', p.since)
        order by p.since desc, p.document_id), '[]'::jsonb)
       from p join public.itinerary_documents d on d.id = p.document_id
       join public.itinerary_fact_drafts f on f.document_id = d.id)
    into v_counts, v_total, v_page;
  end if;

  v_n := jsonb_array_length(v_page);
  if v_n > v_limit then
    v_rows := (select jsonb_agg(e.x order by e.ord) from jsonb_array_elements(v_page) with ordinality as e(x, ord) where e.ord <= v_limit);
  else
    v_rows := v_page;
  end if;
  if v_n > v_limit then
    v_last := v_page -> (v_limit - 1);
    v_last := jsonb_build_object('since', v_last -> 'since', 'id', coalesce(v_last -> 'quotationId', v_last -> 'documentId'));
  end if;
  return jsonb_build_object('applies', true, 'scope', v_scope,
    'filter', jsonb_build_object('status', v_status, 'scope', v_scope, 'reference', v_ref),
    'counts', v_counts, 'total', v_total, 'rows', v_rows, 'hasMore', v_n > v_limit,
    'next', case when v_n > v_limit then jsonb_build_object('since', v_last -> 'since', 'id', v_last -> 'id') end);
end;
$$;

create function public.referral_draft_get(p_draft_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.referral_drafts;
  v_state jsonb;
  v_manage boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into r from public.referral_drafts d where d.id = p_draft_id;
  if r.id is null or not authz.referral_draft_can_edit(r.id) then
    return null;
  end if;
  v_state := authz.referral_draft_state(r.id);
  v_manage := authz.referral_draft_owner_or_manager(r.id);
  return jsonb_build_object(
    'referralDraftId', r.id, 'reference', r.reference, 'branchId', r.branch_id,
    'branchName', (select b.name from public.branches b where b.id = r.branch_id),
    'ownerUserId', r.owner_user_id, 'ownerName', authz.referral_owner_name(r.id),
    'ownerIsYou', r.owner_user_id = (select auth.uid()), 'createdByYou', r.created_by = (select auth.uid()),
    'customer', jsonb_build_object('customerName', r.customer_name, 'mobile', r.mobile, 'email', r.email,
                                   'companyName', r.company_name),
    'source', jsonb_build_object('kind', r.source_kind, 'note', r.source_note),
    'closeNote', r.close_note,
    'linked', exists (select 1 from public.referral_draft_links k where k.referral_draft_id = r.id and k.ended_at is null),
    'bound', authz.referral_draft_bound(r.id),
    'lastActivityAt', r.last_activity_at, 'rowVersion', r.row_version, 'createdAt', r.created_at,
    'switchOn', authz.referral_drafts_enabled(),
    'can', jsonb_build_object(
      'edit', v_state ->> 'status' = 'open',
      'close', v_manage and v_state ->> 'status' = 'open',
      'reopen', v_manage and v_state ->> 'status' = 'closed',
      'reassign', authz.referral_draft_is_manager(r.id) and v_state ->> 'status' = 'open',
      'link', v_state ->> 'status' = 'open',
      'unlink', v_manage and not authz.referral_draft_bound(r.id)),  -- lead ruling Q1: closed drafts too
    'links', coalesce((select jsonb_agg(jsonb_build_object(
        'linkId', k.id, 'targetKind', k.target_kind, 'targetId', coalesce(k.deal_id, k.lead_id),
        'reference', coalesce((select d.reference from public.deals d where d.id = k.deal_id),
                              (select l.reference from public.crm_leads l where l.id = k.lead_id)),
        'title', case when k.deal_id is not null and authz.can_read_deal(k.deal_id)
                        then (select d.title from public.deals d where d.id = k.deal_id)
                      when k.lead_id is not null and authz.can_read_lead(k.lead_id)
                        then (select l.title from public.crm_leads l where l.id = k.lead_id) end,
        'active', k.ended_at is null, 'linkedAt', k.linked_at, 'linkedByYou', k.linked_by = (select auth.uid()),
        'endedAt', k.ended_at, 'endReason', k.end_reason,
        'canRemove', k.ended_at is null and v_manage and not authz.referral_draft_bound(r.id))
      order by k.linked_at desc, k.id) from public.referral_draft_links k where k.referral_draft_id = r.id), '[]'::jsonb),
    'quotations', coalesce((select jsonb_agg(jsonb_build_object(
        'quotationId', q.id, 'reference', q.reference, 'title', q.title,
        'currentVersion', (select jsonb_build_object('versionId', v.id, 'versionNo', v.version_no, 'status', authz.quotation_status(v),
                                                     'validUntil', to_char(v.valid_until, 'YYYY-MM-DD'))
                           from public.quotation_versions v where v.quotation_id = q.id
                           order by (v.status in ('draft', 'ready')) desc, (v.status = 'accepted') desc, (v.status = 'sent') desc,
                                    v.version_no desc limit 1),
        'accepted', q.accepted_version_id is not null, 'converted', q.converted_at is not null, 'linkedDealId', q.linked_deal_id)
      order by q.created_at, q.id) from public.quotations q where q.referral_draft_id = r.id), '[]'::jsonb),
    'itineraries', coalesce((select jsonb_agg(jsonb_build_object(
        'documentId', d.id, 'title', d.title, 'quotationId', d.quotation_id,
        'factsStatus', (select f.status from public.itinerary_fact_drafts f where f.document_id = d.id))
      order by d.created_at, d.id)
      from public.itinerary_documents d left join public.quotations q on q.id = d.quotation_id
      where d.referral_draft_id = r.id or q.referral_draft_id = r.id), '[]'::jsonb))
    || v_state;
end;
$$;

-- Open by reference (exact TD-n), closed drafts included; owner or branch
-- Manager only. Unknown and not-yours give the same null.
create function public.referral_draft_find(p_reference text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ref text := upper(btrim(coalesce(p_reference, '')));
  v_id uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ref !~ '^TD-[1-9][0-9]{0,8}$' then
    return null;
  end if;
  select r.id into v_id from public.referral_drafts r
  where r.reference = v_ref and authz.referral_draft_owner_or_manager(r.id)
  order by r.created_at limit 1;
  return case when v_id is null then null else jsonb_build_object('referralDraftId', v_id) end;
end;
$$;

-- Leads or Deals in the draft's branch the caller can edit (B.4). Matching
-- contact details never preselect; nothing is linked here.
create function public.referral_link_candidates(p_draft_id uuid, p_kind text, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.referral_drafts;
  v_q text := nullif(btrim(coalesce(p_query, ''), E' \t\r\n'), '');
  v_lead public.crm_leads;
  v_has_accepted boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'deal') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if v_q is not null and char_length(v_q) not between 2 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'query';
  end if;
  select * into r from public.referral_drafts d where d.id = p_draft_id;
  if r.id is null or not authz.referral_draft_can_edit(r.id) then
    return null;
  end if;
  select l.* into v_lead from public.referral_draft_links k join public.crm_leads l on l.id = k.lead_id
  where k.referral_draft_id = r.id and k.ended_at is null and k.lead_id is not null;
  v_has_accepted := exists (select 1 from public.quotations q where q.referral_draft_id = r.id and q.accepted_version_id is not null);
  if p_kind = 'deal' then
    return coalesce((select jsonb_agg(x.j order by x.from_lead desc, x.at desc, x.id) from (
      select d.id, d.created_at as at,
        coalesce(v_lead.id is not null and d.source_lead_id = v_lead.source_lead_id and d.source_portal = v_lead.source_portal, false) as from_lead,
        jsonb_build_object('kind', 'deal', 'id', d.id, 'reference', d.reference, 'title', d.title,
          'branchName', (select b.name from public.branches b where b.id = d.branch_id),
          'active', not authz.deal_not_active(d.id),
          'fromLinkedLead', coalesce(v_lead.id is not null and d.source_lead_id = v_lead.source_lead_id
                                     and d.source_portal = v_lead.source_portal, false),
          'alreadyHasAcceptedQuotation', exists (select 1 from public.quotations o
                                                 where o.linked_deal_id = d.id or (o.deal_id = d.id and o.accepted_version_id is not null)),
          'linkable', not authz.deal_not_active(d.id)
                      and (v_lead.id is null or (d.source_lead_id = v_lead.source_lead_id and d.source_portal = v_lead.source_portal))
                      and not (v_has_accepted and exists (select 1 from public.quotations o
                                 where o.linked_deal_id = d.id or (o.deal_id = d.id and o.accepted_version_id is not null)))) as j
      from public.deals d
      where d.legal_entity_id = r.legal_entity_id and d.branch_id = r.branch_id and d.removed_at is null
        and authz.can_edit_booking_draft(d.id)
        and (v_q is null or upper(d.reference) = upper(v_q) or position(lower(v_q) in lower(d.title)) > 0)
      order by 3 desc, d.created_at desc, d.id limit 25) x), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(x.j order by x.at desc, x.id) from (
    select l.id, l.created_at as at,
      jsonb_build_object('kind', 'lead', 'id', l.id, 'reference', l.reference, 'title', l.title,
        'branchName', (select b.name from public.branches b where b.id = l.branch_id),
        'active', true, 'fromLinkedLead', false,
        'alreadyHasAcceptedQuotation', exists (select 1 from public.quotations o where o.lead_id = l.id and o.accepted_version_id is not null),
        'linkable', true) as j
    from public.crm_leads l
    where l.legal_entity_id = r.legal_entity_id and l.branch_id = r.branch_id and authz.quotation_lead_editor(l.id)
      and (v_q is null or upper(l.reference) = upper(v_q) or position(lower(v_q) in lower(l.title)) > 0)
    order by l.created_at desc, l.id limit 25) x), '[]'::jsonb);
end;
$$;

-- "Change owner" choices (DA-76): branch Manager only.
create function public.referral_owner_candidates(p_draft_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.referral_drafts;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into r from public.referral_drafts d where d.id = p_draft_id;
  if r.id is null or not authz.referral_draft_is_manager(r.id) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('userId', p.user_id, 'displayName', p.display_name,
                                        'isCurrentOwner', p.user_id = r.owner_user_id) order by p.display_name, p.user_id)
    from public.staff_profiles p
    where p.user_id <> (select auth.uid())
      and exists (select 1 from public.memberships m
                  join public.legal_entities e on e.id = m.legal_entity_id
                  join public.branches b on b.id = m.branch_id
                  where m.user_id = p.user_id and m.legal_entity_id = r.legal_entity_id and m.branch_id = r.branch_id
                    and m.role_code = 'sales' and m.status = 'active' and e.status = 'enabled' and b.status = 'enabled')
      and not exists (select 1 from public.memberships x where x.user_id = p.user_id and x.legal_entity_id = r.legal_entity_id
                      and x.role_code = 'purchase' and x.status = 'active')), '[]'::jsonb);
end;
$$;

-- Drafts actively linked to a Lead or Deal (DA-71 "Referral drafts for this deal").
create function public.referral_drafts_for_subject(p_subject_kind text, p_subject_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_id is null or p_subject_kind is null or p_subject_kind not in ('lead', 'deal')
     or (p_subject_kind = 'deal' and not authz.can_edit_booking_draft(p_subject_id))
     or (p_subject_kind = 'lead' and not authz.quotation_lead_editor(p_subject_id))
     or (p_subject_kind = 'deal' and exists (select 1 from public.deals d where d.id = p_subject_id and d.removed_at is not null)) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('referralDraftId', r.id, 'reference', r.reference, 'customerName', r.customer_name,
        'ownerName', authz.referral_owner_name(r.id), 'ownerIsYou', r.owner_user_id = (select auth.uid()),
        'quotationCount', (select count(*) from public.quotations q where q.referral_draft_id = r.id),
        'hasAccepted', exists (select 1 from public.quotations q where q.referral_draft_id = r.id and q.accepted_version_id is not null))
      || authz.referral_draft_state(r.id)
      order by r.created_at, r.id)
    from public.referral_drafts r
    where exists (select 1 from public.referral_draft_links k
                  where k.referral_draft_id = r.id and k.ended_at is null
                    and ((p_subject_kind = 'deal' and k.deal_id = p_subject_id) or (p_subject_kind = 'lead' and k.lead_id = p_subject_id)))
      and authz.referral_draft_can_edit(r.id)), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function
  authz.referral_resume_clock(), authz.referral_drafts_enabled(), authz.referral_drafts_guard(),
  authz.referral_draft_links_guard(), authz.referral_refuse_truncate(),
  authz.referral_draft_owner_or_manager(uuid), authz.referral_draft_is_manager(uuid), authz.referral_draft_can_edit(uuid),
  authz.referral_branch_creator(uuid), authz.referral_draft_bound(uuid), authz.referral_due_on(timestamptz),
  authz.referral_close_due_on(uuid), authz.referral_draft_due(uuid), authz.referral_draft_state(uuid),
  authz.referral_draft_closed(uuid), authz.referral_draft_brief(uuid), authz.referral_draft_lock_write(uuid),
  authz.referral_draft_persist_auto_close(uuid), authz.quotation_bitrix_subject(uuid), authz.referral_customer_bad(jsonb, boolean),
  authz.referral_note(text, integer, integer, text), authz.referral_owner_name(uuid),
  authz.work_quotation_rows(), authz.work_itinerary_rows(),
  authz.referral_draft_start(uuid, jsonb, text, uuid, text), authz.referral_duplicates(uuid),
  authz.provision_referral_close_job(), authz.referral_activity_from_audit(), authz.itinerary_documents_referral_guard(), authz.referral_active_link(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.quotation_create_standalone(uuid, jsonb, text, uuid),
  public.itinerary_create_standalone(uuid, jsonb, text, uuid),
  public.referral_draft_save(uuid, integer, jsonb),
  public.referral_draft_close(uuid, integer, text, text),
  public.referral_draft_reopen(uuid, integer, text),
  public.referral_draft_reassign(uuid, integer, uuid, text),
  public.referral_draft_link(uuid, integer, text, uuid, text),
  public.referral_draft_unlink(uuid, integer, text, text),
  public.referral_drafts_close_inactive(integer),
  public.work_drafts_list(text, jsonb, jsonb, integer),
  public.referral_draft_get(uuid),
  public.referral_draft_find(text),
  public.referral_link_candidates(uuid, text, text),
  public.referral_owner_candidates(uuid),
  public.referral_drafts_for_subject(text, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.quotation_create_standalone(uuid, jsonb, text, uuid),
  public.itinerary_create_standalone(uuid, jsonb, text, uuid),
  public.referral_draft_save(uuid, integer, jsonb),
  public.referral_draft_close(uuid, integer, text, text),
  public.referral_draft_reopen(uuid, integer, text),
  public.referral_draft_reassign(uuid, integer, uuid, text),
  public.referral_draft_link(uuid, integer, text, uuid, text),
  public.referral_draft_unlink(uuid, integer, text, text),
  public.work_drafts_list(text, jsonb, jsonb, integer),
  public.referral_draft_get(uuid),
  public.referral_draft_find(text),
  public.referral_link_candidates(uuid, text, text),
  public.referral_owner_candidates(uuid),
  public.referral_drafts_for_subject(text, uuid)
to authenticated;

grant execute on function public.referral_drafts_close_inactive(integer) to service_role;

comment on function public.work_drafts_list(text, jsonb, jsonb, integer) is
  'Batch 3 (FP-040, FP-051): scoped Quotations / Itineraries lists: everything the caller may open today (Sales own/assigned, Manager branch), filter chips with exact counts in the named scope, keyset pages. Closed never-linked referral drafts only under closed_drafts or an exact reference. No money.';
comment on function public.referral_drafts_close_inactive(integer) is
  'Batch 3 (B.9, F.3.3): closes referral drafts 90 IST days without activity, only while the referral_drafts switch is on. service_role only; batch 1-200; idempotent; one audit row per draft.';

commit;
