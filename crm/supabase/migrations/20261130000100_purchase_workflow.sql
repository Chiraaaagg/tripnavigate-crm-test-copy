-- TripNavigate CRM - Purchase build, track A (1 of 3): schema and helpers for
-- the hotel go-ahead, supplier e-mails and trip cancellation charges.
-- Contract: purchase build contract, section A (frozen 2 November 2026);
-- owner decisions 1, 4 and 5 of 2 November 2026.
--
-- What this file adds:
--   1. purchase_quotes: per_room_night_paise (optional rate per room per
--      night) and note (up to 300 characters). Quote facts stay immutable
--      (authz.purchase_quotes_guard compares every column except status).
--      For transfer and activity tasks hotel_name holds the service name.
--   2. procurement_settings.supplier_email_sending_enabled (default false),
--      watched by the settings audit trigger and changed only through
--      public.admin_set_supplier_email_sending (Super Admin, reason), which
--      mirrors admin_set_supplier_confirmation_live.
--   3. purchase_supplier_emails: rate and booking request e-mails, append-only
--      except queued -> sent / failed after the provider call.
--   4. purchase_go_ahead_requests: one request to Accounts per booking request
--      on a hotel task, bound to {task, booking version, offer, cost version,
--      amount}. At most one pending per task. Validity is computed
--      (authz.purchase_go_ahead_valid), never stored.
--   5. deal_cancellations (one per Deal) and purchase_cancellation_charges
--      (append-only revisions per cancellation and task).
--   6. Helpers: authz.purchase_has_live_payment (returns false; track B
--      replaces it), authz.deal_trip_cancelled, authz.purchase_agreed_cost,
--      authz.purchase_go_ahead_needed / _request_current / _valid / _state,
--      authz.purchase_booking_request_sent, authz.cancellation_charges_missing,
--      authz.cancellation_credit_note_ok (track B may widen it to its files),
--      authz.supplier_email_normalize, authz.supplier_email_sending_enabled.
--   7. authz.procurement_issues gains trip_cancelled, booking_request_not_sent
--      and go_ahead_missing after the Phase 4 issues (body otherwise copied
--      from 20261005000200).
--
-- Reads of the new tables go only through SECURITY DEFINER functions: no
-- table grant to authenticated (as supplier_beneficiary_revisions), so Sales
-- never reads supplier costs or cancellation amounts through the Data API.
-- Audit rows never carry amounts, bank values or e-mail text.
--
-- Rollback (forward-only): a new migration revoking execute on the new
-- public functions from authenticated and restoring authz.procurement_issues
-- from 20261005000200. Never delete e-mail, go-ahead, cancellation or audit
-- rows.
--
-- Apply history: written 2 November 2026; run only on disposable local test
-- databases. Not applied to any hosted project.

begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Offers: rate per room per night and a short note
-- ---------------------------------------------------------------------------

alter table public.purchase_quotes
  add column per_room_night_paise bigint check (per_room_night_paise is null or per_room_night_paise > 0),
  add column note text check (note is null or length(note) between 1 and 300);
comment on column public.purchase_quotes.hotel_name is
  'Hotel name for hotel tasks; the service name (vehicle, activity) for transfer and activity tasks.';
comment on column public.purchase_quotes.per_room_night_paise is
  'Optional supplier rate per room per night (hotel). Immutable like every quote fact.';

-- ---------------------------------------------------------------------------
-- 2. Supplier e-mail sending switch
-- ---------------------------------------------------------------------------

alter table public.procurement_settings
  add column supplier_email_sending_enabled boolean not null default false;

-- The settings audit trigger (20261114000100) now also watches the new column.
drop trigger procurement_settings_audit on public.procurement_settings;
create trigger procurement_settings_audit
  after insert or update or delete on public.procurement_settings
  for each row execute function authz.audit_settings_change(
    'settings.procurement_changed', 'live_supplier_confirmation_enabled', 'supplier_email_sending_enabled');

comment on table public.procurement_settings is
  'Single row. live_supplier_confirmation_enabled changes through public.admin_set_supplier_confirmation_live and supplier_email_sending_enabled through public.admin_set_supplier_email_sending (Super Admin, reason) or owner SQL; every change is audited by trigger (settings.procurement_changed).';

-- Mirrors admin_set_supplier_confirmation_live (20261114000100).
create function public.admin_set_supplier_email_sending(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.procurement_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_enabled is null then
    raise exception 'invalid switch' using errcode = '22023';
  end if;
  select s.supplier_email_sending_enabled into v_before from public.procurement_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_supplier_email_sending', v_reason);
  update public.procurement_settings s set supplier_email_sending_enabled = p_enabled where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);

  return jsonb_build_object('changed', v_before is distinct from v_after.supplier_email_sending_enabled,
    'before', v_before, 'after', v_after.supplier_email_sending_enabled, 'updatedAt', v_after.updated_at);
end;
$$;
revoke all on function public.admin_set_supplier_email_sending(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_supplier_email_sending(boolean, text) to authenticated;

create function authz.supplier_email_sending_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.supplier_email_sending_enabled from public.procurement_settings s where s.id), false)
$$;

-- ---------------------------------------------------------------------------
-- 3. Supplier e-mails
-- ---------------------------------------------------------------------------

create table public.purchase_supplier_emails (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  task_id uuid not null,
  deal_id uuid not null references public.deals (id),
  kind text not null check (kind in ('rate_request', 'booking_request')),
  supplier_id uuid not null,
  to_email text not null check (length(to_email) <= 254
    and to_email ~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]{2,}$'),
  cc_emails text[] not null default '{}'::text[]
    check (cardinality(cc_emails) <= 10 and array_position(cc_emails, null) is null),
  subject text not null check (length(subject) between 1 and 300),
  body text not null check (length(body) between 1 and 8000),
  quote_id uuid,
  cost_version_no integer check (cost_version_no is null or cost_version_no >= 1),
  -- Booking request: the final rate it asked the supplier to book (never a selling price).
  amount_paise bigint check (amount_paise is null or amount_paise > 0),
  status text not null check (status in ('marked_sent', 'queued', 'sent', 'failed')),
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 1 and 200),
  failure text check (failure is null or length(failure) between 1 and 500),
  sent_by uuid not null references public.staff_profiles (user_id),
  sent_at timestamptz not null default now(),
  result_at timestamptz,
  request_id uuid not null,
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  foreign key (task_id, quote_id) references public.purchase_quotes (task_id, id),
  foreign key (task_id, cost_version_no) references public.purchase_cost_versions (task_id, version_no),
  unique (legal_entity_id, request_id),
  check ((kind = 'booking_request') = (quote_id is not null and cost_version_no is not null and amount_paise is not null)),
  check (status <> 'sent' or provider_message_id is not null),
  check (status <> 'failed' or failure is not null),
  check ((status in ('sent', 'failed')) = (result_at is not null))
);
create index purchase_supplier_emails_task_idx on public.purchase_supplier_emails (task_id, sent_at desc);
comment on table public.purchase_supplier_emails is
  'Rate and booking request e-mails to suppliers. marked_sent = sent by the person from their own e-mail app (switch off); queued -> sent/failed = sent through the CRM (switch on). Append-only except the provider result. No table grant; read through purchase_workspace.';

create function authz.purchase_supplier_emails_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier e-mail rows cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'provider_message_id', 'failure', 'result_at'])
     is distinct from (to_jsonb(old) - array['status', 'provider_message_id', 'failure', 'result_at'])
     or old.status <> 'queued' or new.status not in ('sent', 'failed') then
    raise exception 'supplier e-mail rows are append-only; only a queued e-mail gets its send result' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger purchase_supplier_emails_a_guard
  before update or delete on public.purchase_supplier_emails
  for each row execute function authz.purchase_supplier_emails_guard();

-- ---------------------------------------------------------------------------
-- 4. Hotel go-ahead requests (owner decision 1)
-- ---------------------------------------------------------------------------

create table public.purchase_go_ahead_requests (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null references public.deals (id),
  task_id uuid not null,
  booking_version_id uuid not null references public.booking_versions (id),
  quote_id uuid not null,
  cost_version_no integer not null check (cost_version_no >= 1),
  amount_paise bigint not null check (amount_paise > 0),
  -- superseded = a stale pending request replaced by a newer booking request.
  status text not null default 'pending' check (status in ('pending', 'approved', 'returned', 'superseded')),
  requested_by uuid not null references public.staff_profiles (user_id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  decision_request_id uuid,
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  email_id uuid not null references public.purchase_supplier_emails (id),
  request_id uuid not null,
  row_version integer not null default 1 check (row_version >= 1),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, quote_id) references public.purchase_quotes (task_id, id),
  foreign key (task_id, cost_version_no) references public.purchase_cost_versions (task_id, version_no),
  unique (legal_entity_id, request_id),
  check ((status in ('approved', 'returned')) = (decided_by is not null and decided_at is not null and decision_request_id is not null)),
  check ((status = 'returned') = (return_reason is not null)),
  check (decided_by is null or decided_by <> requested_by)
);
create unique index purchase_go_ahead_requests_one_pending on public.purchase_go_ahead_requests (task_id)
  where status = 'pending';
create index purchase_go_ahead_requests_task_idx on public.purchase_go_ahead_requests (task_id, requested_at desc);
create index purchase_go_ahead_requests_entity_idx on public.purchase_go_ahead_requests (legal_entity_id, status, requested_at desc);
comment on table public.purchase_go_ahead_requests is
  'Owner decision 1 (2 Nov 2026): Accounts go-ahead for a hotel commitment, bound to the booking version, offer, cost version and amount. Validity is computed (authz.purchase_go_ahead_valid). Only pending -> approved/returned/superseded. No table grant.';

create function authz.purchase_go_ahead_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'go-ahead requests cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_request_id', 'return_reason', 'row_version'])
     is distinct from (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_request_id', 'return_reason', 'row_version'])
     or old.status <> 'pending' or new.status = 'pending' then
    raise exception 'a go-ahead request is decided once; its facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger purchase_go_ahead_requests_a_guard
  before update or delete on public.purchase_go_ahead_requests
  for each row execute function authz.purchase_go_ahead_requests_guard();

-- ---------------------------------------------------------------------------
-- 5. Trip cancellation (owner decision 4)
-- ---------------------------------------------------------------------------

create table public.deal_cancellations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  reason text not null check (length(reason) between 10 and 500),
  status text not null default 'open' check (status in ('open', 'charges_entered', 'sent_to_manager', 'approved')),
  opened_by uuid not null references public.staff_profiles (user_id),
  opened_at timestamptz not null default now(),
  request_id uuid not null,
  sent_by uuid references public.staff_profiles (user_id),
  sent_at timestamptz,
  sent_request_id uuid,
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  decision_request_id uuid,
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  check (status <> 'approved' or (decided_by is not null and decided_at is not null)),
  check (status <> 'sent_to_manager' or (sent_by is not null and sent_at is not null))
);
-- One cancellation case per Deal: approved is final (no reopening in this batch).
create unique index deal_cancellations_one_per_deal on public.deal_cancellations (deal_id);
comment on table public.deal_cancellations is
  'Owner decision 4 (2 Nov 2026): the branch Manager marks the trip cancelled; Purchase enters supplier charges; the Manager (not a person who entered a current charge) approves or returns. Customer refund side not built. No table grant.';

create function authz.deal_cancellations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'trip cancellations cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'sent_by', 'sent_at', 'sent_request_id', 'decided_by', 'decided_at',
                            'decision_request_id', 'return_reason', 'row_version', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'sent_by', 'sent_at', 'sent_request_id', 'decided_by', 'decided_at',
                            'decision_request_id', 'return_reason', 'row_version', 'updated_at'])
     or old.status = 'approved' then
    raise exception 'trip cancellation facts are immutable and approval is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger deal_cancellations_a_guard
  before update or delete on public.deal_cancellations
  for each row execute function authz.deal_cancellations_guard();

create table public.purchase_cancellation_charges (
  id uuid primary key default gen_random_uuid(),
  cancellation_id uuid not null references public.deal_cancellations (id),
  legal_entity_id uuid not null,
  task_id uuid not null,
  revision_no integer not null check (revision_no >= 1),
  supplier_id uuid not null,
  -- Snapshot of the task's latest cost when the charge was entered.
  committed_cost_paise bigint not null check (committed_cost_paise > 0),
  supplier_keeps_paise bigint not null check (supplier_keeps_paise >= 0),
  supplier_refund_paise bigint not null check (supplier_refund_paise >= 0),
  note text check (note is null or length(note) between 1 and 500),
  credit_note_evidence_id uuid,
  entered_by uuid not null references public.staff_profiles (user_id),
  entered_at timestamptz not null default now(),
  request_id uuid not null,
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  unique (cancellation_id, task_id, revision_no),
  unique (legal_entity_id, request_id)
);
create index purchase_cancellation_charges_task_idx on public.purchase_cancellation_charges (task_id, cancellation_id, revision_no desc);
comment on table public.purchase_cancellation_charges is
  'Append-only revisions of what a supplier keeps and refunds on one task of a cancelled trip; the latest revision is current. Purchase and the branch Manager read them through definer functions; no table grant.';
create trigger purchase_cancellation_charges_a_append_only
  before update or delete on public.purchase_cancellation_charges
  for each row execute function authz.procurement_append_only();

-- ---------------------------------------------------------------------------
-- Row level security and grants: definer functions only
-- ---------------------------------------------------------------------------

alter table public.purchase_supplier_emails enable row level security;
alter table public.purchase_go_ahead_requests enable row level security;
alter table public.deal_cancellations enable row level security;
alter table public.purchase_cancellation_charges enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['purchase_supplier_emails', 'purchase_go_ahead_requests', 'deal_cancellations',
                           'purchase_cancellation_charges'] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

revoke all on public.purchase_supplier_emails, public.purchase_go_ahead_requests, public.deal_cancellations,
  public.purchase_cancellation_charges
from public, anon, authenticated, service_role;

-- Outbox is untouched: nothing here is sent to Bitrix or creates money.

-- ---------------------------------------------------------------------------
-- 6. Helpers
-- ---------------------------------------------------------------------------

-- Track B (20261130000200) replaces this with the real check: a live
-- supplier payment request on the task's latest cost version.
create function authz.purchase_has_live_payment(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select false and p_task is not null
$$;

-- Owner decision 4: an open (or approved) trip cancellation stops new
-- commitments on the Deal.
create function authz.deal_trip_cancelled(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deal_cancellations c where c.deal_id = p_deal)
$$;

-- The latest PROPOSED cost version: the agreed final rate. Before supplier
-- confirmation it is the latest version; after it, the version the committed
-- copy came from (purchase_supplier_confirm adds the committed row as +1).
create function authz.purchase_agreed_cost(p_task uuid) returns public.purchase_cost_versions
language sql stable security definer set search_path = '' as $$
  select c.* from public.purchase_cost_versions c
  where c.task_id = p_task and c.stage = 'proposed'
  order by c.version_no desc limit 1
$$;

-- Owner decision 1: hotel tasks of the Purchase department need a go-ahead
-- (a package's hotel items are hotel tasks).
create function authz.purchase_go_ahead_needed(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fulfilment_tasks t
                 where t.id = p_task and t.department = 'purchase' and t.service_purpose = 'hotel')
$$;

-- A request still matches the item's current accepted version and the agreed
-- cost version and offer.
create function authz.purchase_go_ahead_request_current(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select r.booking_version_id = authz.task_current_version(r.task_id)
       and a.version_no = r.cost_version_no and a.quote_id = r.quote_id and a.amount_paise = r.amount_paise
    from public.purchase_go_ahead_requests r
    cross join lateral (select * from authz.purchase_agreed_cost(r.task_id)) a
    where r.id = p_request), false)
$$;

-- Valid = approved, still current, and the Accounts booking review of that
-- booking version is still approved (a review moved back to returned by
-- accounts_review_return voids the go-ahead until it is approved again).
create function authz.purchase_go_ahead_valid(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.purchase_go_ahead_requests r
    where r.task_id = p_task and r.status = 'approved' and authz.purchase_go_ahead_request_current(r.id)
      and exists (select 1 from public.accounts_booking_reviews b
                  where b.booking_version_id = r.booking_version_id and b.status = 'approved'))
$$;

-- not_needed | not_requested | pending | approved | returned | stale
create function authz.purchase_go_ahead_state(p_task uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.purchase_go_ahead_requests%rowtype;
begin
  if not authz.purchase_go_ahead_needed(p_task) then
    return 'not_needed';
  end if;
  if authz.purchase_go_ahead_valid(p_task) then
    return 'approved';
  end if;
  -- The latest request; a pending one is always the newest (a new request
  -- supersedes the pending one), also within one transaction.
  select * into v from public.purchase_go_ahead_requests r
  where r.task_id = p_task and r.status <> 'superseded'
  order by (r.status = 'pending') desc, r.requested_at desc, r.id desc limit 1;
  if v.id is null then
    return 'not_requested';
  end if;
  if not authz.purchase_go_ahead_request_current(v.id) then
    return 'stale';
  end if;
  return case v.status when 'pending' then 'pending' when 'returned' then 'returned' else 'stale' end;
end;
$$;

-- A booking request for the agreed cost version was sent (by the CRM) or
-- marked as sent. A queued or failed send does not count.
create function authz.purchase_booking_request_sent(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.purchase_supplier_emails e
    cross join lateral (select * from authz.purchase_agreed_cost(p_task)) a
    where e.task_id = p_task and e.kind = 'booking_request' and e.status in ('marked_sent', 'sent')
      and e.cost_version_no = a.version_no)
$$;

-- Purchase tasks of the Deal with an agreed or committed cost and no charge
-- in this cancellation yet.
create function authz.cancellation_charges_missing(p_cancellation uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer
  from public.deal_cancellations c
  join public.fulfilment_tasks t on t.deal_id = c.deal_id and t.department = 'purchase'
  where c.id = p_cancellation
    and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id)
    and not exists (select 1 from public.purchase_cancellation_charges x
                    where x.cancellation_id = c.id and x.task_id = t.id)
$$;

-- A credit note file for a cancellation charge: a stored Purchase file of
-- the same task. Track B may replace this to also accept its supplier-money
-- credit notes.
create function authz.cancellation_credit_note_ok(p_task uuid, p_evidence uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.purchase_evidence e
                 where e.id = p_evidence and e.task_id = p_task and e.status = 'stored')
$$;

-- Validates and normalizes one supplier e-mail. Raises invalid_input.
-- Returns {to, cc[], subject, body}: trimmed, Cc without blanks, duplicates
-- or the To address.
create function authz.supplier_email_normalize(p_to text, p_cc text[], p_subject text, p_body text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_re constant text := '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]{2,}$';
  v_to text := btrim(coalesce(p_to, ''));
  v_cc text[] := '{}'::text[];
  v_seen text[];
  v_c text;
  v_subject text := btrim(coalesce(p_subject, ''), E' \t\r\n');
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
begin
  if length(v_to) > 254 or v_to !~ v_re then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_seen := array[lower(v_to)];
  if p_cc is not null then
    if cardinality(p_cc) > 10 then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    foreach v_c in array p_cc loop
      v_c := btrim(coalesce(v_c, ''));
      continue when v_c = '';
      if length(v_c) > 254 or v_c !~ v_re then
        raise exception 'invalid_input' using errcode = '22023';
      end if;
      continue when lower(v_c) = any (v_seen);
      v_seen := v_seen || lower(v_c);
      v_cc := v_cc || v_c;
    end loop;
  end if;
  if length(v_subject) not between 1 and 300 or v_subject ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if length(v_body) not between 1 and 8000 or v_body ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return jsonb_build_object('to', v_to, 'cc', to_jsonb(v_cc), 'subject', v_subject, 'body', v_body);
end;
$$;

-- A reason typed by a decider: 10 to 500 characters, line breaks allowed.
create function authz.purchase_reason(p_reason text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := btrim(coalesce(p_reason, ''), E' \t\r\n');
begin
  if char_length(v) not between 10 and 500 or v ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Readiness (replaces 20261005000200): Phase 4 issues unchanged, then
-- trip_cancelled, booking_request_not_sent and go_ahead_missing (the last two
-- only once the final rate is agreed and within budget or approved).
-- ---------------------------------------------------------------------------

create or replace function authz.procurement_issues(p_task uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issues text[] := '{}'::text[];
  v_gate text := authz.procurement_gate_issue(p_task);
  v_cost public.purchase_cost_versions;
  v_budget bigint;
  v_deal uuid;
begin
  if v_gate is not null then
    v_issues := v_issues || v_gate;
  end if;
  if not exists (select 1 from public.purchase_quotes q where q.task_id = p_task and q.status = 'open') then
    v_issues := v_issues || 'missing_quote'::text;
  end if;
  v_cost := authz.purchase_latest_cost(p_task);
  if v_cost.id is null then
    v_issues := v_issues || 'missing_cost'::text;
  else
    if not exists (select 1 from public.purchase_quotes q where q.id = v_cost.quote_id and q.status = 'open') then
      v_issues := v_issues || 'cost_not_for_quote'::text;
    end if;
    v_budget := authz.task_budget(p_task);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(p_task, v_cost.version_no) then
      v_issues := v_issues || 'over_budget'::text;
    end if;
  end if;
  if not exists (select 1 from public.purchase_evidence e
                 where e.task_id = p_task and e.kind = 'supplier_confirmation' and e.status = 'stored') then
    v_issues := v_issues || 'missing_supplier_confirmation_proof'::text;
  end if;
  if exists (select 1 from public.purchase_evidence e where e.task_id = p_task and e.status = 'pending_upload') then
    v_issues := v_issues || 'evidence_upload_incomplete'::text;
  end if;
  -- Purchase build (owner decisions 1 and 4).
  select t.deal_id into v_deal from public.fulfilment_tasks t where t.id = p_task;
  if authz.deal_trip_cancelled(v_deal) then
    v_issues := v_issues || 'trip_cancelled'::text;
  end if;
  -- The booking request needs an agreed final rate within budget (or
  -- approved above it); while one of those is missing, only that is listed.
  if not (v_issues && array['missing_cost', 'cost_not_for_quote', 'over_budget']) then
    if not authz.purchase_booking_request_sent(p_task) then
      v_issues := v_issues || 'booking_request_not_sent'::text;
    end if;
    if authz.purchase_go_ahead_needed(p_task) and not authz.purchase_go_ahead_valid(p_task) then
      v_issues := v_issues || 'go_ahead_missing'::text;
    end if;
  end if;
  return v_issues;
end;
$$;

revoke all on function
  authz.supplier_email_sending_enabled(), authz.purchase_supplier_emails_guard(),
  authz.purchase_go_ahead_requests_guard(), authz.deal_cancellations_guard(),
  authz.purchase_has_live_payment(uuid), authz.deal_trip_cancelled(uuid), authz.purchase_agreed_cost(uuid),
  authz.purchase_go_ahead_needed(uuid), authz.purchase_go_ahead_request_current(uuid),
  authz.purchase_go_ahead_valid(uuid), authz.purchase_go_ahead_state(uuid),
  authz.purchase_booking_request_sent(uuid), authz.cancellation_charges_missing(uuid),
  authz.cancellation_credit_note_ok(uuid, uuid), authz.supplier_email_normalize(text, text[], text, text),
  authz.purchase_reason(text)
from public, anon, authenticated, service_role;
-- authz.procurement_issues keeps its ACL (CREATE OR REPLACE; revoked from
-- public, anon and authenticated in 20261005000100).

commit;
