-- TripNavigate CRM - Accounts phase 3, track A: customer message schema and
-- the frozen queueing function authz.cmsg_enqueue.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 5.3, 5.4, 5.5,
-- 5.6 (schema parts), 17.2 (switches Off, pilot list On), LD3-LD8.
--
-- 1. deal_message_prefs (language, WhatsApp number, e-mail correction, channel
--    switches on the Deal) and customer_whatsapp_optouts (per phone number).
-- 2. customer_messages (queue and log; the address is never stored, only a
--    mask), customer_message_events (delivery reports and inbound STOP/START,
--    no text, no address), customer_message_switches (18 per entity, Off),
--    customer_message_settings (pilot_only On), customer_message_pilot,
--    whatsapp_templates (18 per entity, not_submitted), customer_message_alerts
--    (track D: notices 43, 44), flight_boarding_pass_alerts (notice 45),
--    customer_message_enqueue_failures (counts for task customer_message_health).
-- 3. purchase_evidence kind customer_voucher (+ customer_ready_at/by);
--    department_evidence kind boarding_pass.
-- 4. authz.cmsg_enqueue(deal, type, event_key, params, attachment) returns
--    integer - FROZEN signature, used by track A's triggers and by tracks G
--    and H. No row when the type x channel switch is Off (LD6); otherwise one
--    row per channel, queued or skipped / stopped with the reason, in the 5.5
--    order. Quiet hours (LD5). Never fails the staff step that caused it.
--    Callers pass only the type-specific params (amountPaise, balancePaise,
--    hotelName, checkIn, checkOut, travellerName, outcome, daysLeft); the base
--    params (customerName, dealReference, destination, tripStart, tripEnd,
--    travellerCount) are read from the Deal's confirmed booking.
--
-- Refusal tokens (inside authz only): invalid_input (22023).
-- Rollback (forward-only): a NEW migration dropping these objects and
-- restoring the two kind checks (only while no customer_voucher /
-- boarding_pass row exists).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Vocabularies and pure helpers
-- ===========================================================================

create function authz.cmsg_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['booking_confirmed', 'payment_received', 'hotel_voucher', 'e_ticket', 'boarding_pass', 'visa_status',
               'trip_reminder', 'refund_paid', 'booking_changed']
$$;

-- LD5: held back 21:00-08:00 India time.
create function authz.cmsg_quiet(p_type text) returns boolean
language sql immutable set search_path = '' as $$
  select p_type in ('booking_confirmed', 'hotel_voucher', 'visa_status', 'trip_reminder', 'booking_changed')
$$;

-- Template variables in order ({{1}} = first key), contract 5.5.
create function authz.cmsg_param_keys(p_type text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_type
    when 'booking_confirmed' then array['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd', 'travellerCount']
    when 'payment_received' then array['customerName', 'dealReference', 'amountPaise', 'balancePaise']
    when 'hotel_voucher' then array['customerName', 'dealReference', 'hotelName', 'checkIn', 'checkOut']
    when 'e_ticket' then array['customerName', 'dealReference']
    when 'boarding_pass' then array['customerName', 'dealReference']
    when 'visa_status' then array['customerName', 'dealReference', 'travellerName', 'outcome']
    when 'trip_reminder' then array['customerName', 'dealReference', 'destination', 'tripStart', 'daysLeft']
    when 'refund_paid' then array['customerName', 'dealReference', 'amountPaise']
    when 'booking_changed' then array['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd']
  end
$$;

create function authz.cmsg_template_code(p_type text, p_language text) returns text
language sql immutable set search_path = '' as $$
  select 'tn_' || p_type || '_' || p_language || '_v1'
$$;

-- Quiet types queued between 21:00 and 08:00 India time wait for the next 08:00.
create function authz.cmsg_not_before(p_type text, p_at timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$
  select case
    when not authz.cmsg_quiet(p_type) then p_at
    when (p_at at time zone 'Asia/Kolkata')::time >= time '21:00'
      then (((p_at at time zone 'Asia/Kolkata')::date + 1) + time '08:00') at time zone 'Asia/Kolkata'
    when (p_at at time zone 'Asia/Kolkata')::time < time '08:00'
      then ((p_at at time zone 'Asia/Kolkata')::date + time '08:00') at time zone 'Asia/Kolkata'
    else p_at
  end
$$;

-- 98xxxxxx12
create function authz.cmsg_mask_mobile(p_mobile text) returns text
language sql immutable set search_path = '' as $$
  select case when p_mobile ~ '^[0-9]{10}$' then left(p_mobile, 2) || 'xxxxxx' || right(p_mobile, 2) end
$$;

-- p***@example.test
create function authz.cmsg_mask_email(p_email text) returns text
language sql immutable set search_path = '' as $$
  select case when p_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    then left(p_email, 1) || '***@' || split_part(p_email, '@', 2) end
$$;

-- Date as customers read it: 01 Dec 2026.
create function authz.cmsg_date(p_date date) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_date, 'DD Mon YYYY')
$$;

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

create table public.deal_message_prefs (
  deal_id uuid primary key,
  legal_entity_id uuid not null,
  branch_id uuid not null,
  language text not null default 'en' check (language in ('en', 'hi')),
  -- null = the booking contact's mobile ("same as mobile").
  whatsapp_mobile text check (whatsapp_mobile ~ '^[6-9][0-9]{9}$'),
  -- A correction made after confirmation (same rule as booking_version_contacts.email).
  email_override text check (length(email_override) <= 254 and email_override ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  whatsapp_off boolean not null default false,
  email_off boolean not null default false,
  off_reason text check (off_reason is null or length(off_reason) between 10 and 300),
  last_request_id uuid,
  row_version integer not null default 1 check (row_version >= 1),
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  check (not (whatsapp_off or email_off) or off_reason is not null)
);
create index deal_message_prefs_deal_fk_idx on public.deal_message_prefs (legal_entity_id, branch_id, deal_id);
create index deal_message_prefs_updated_by_idx on public.deal_message_prefs (updated_by) where updated_by is not null;
create index deal_message_prefs_whatsapp_idx on public.deal_message_prefs (whatsapp_mobile) where whatsapp_mobile is not null;

create table public.customer_messages (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  message_type text not null check (message_type = any (authz.cmsg_types())),
  channel text not null check (channel in ('email', 'whatsapp')),
  language text not null check (language in ('en', 'hi')),
  event_key text not null check (length(event_key) between 1 and 120),
  status text not null check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'stopped')),
  skip_reason text check (skip_reason in ('test_deal', 'not_in_pilot', 'no_contact', 'channel_off_on_deal', 'opted_out',
                                          'trip_cancelled', 'change_in_progress', 'template_not_approved', 'file_missing',
                                          -- Addition (lead OK needed): the type x channel switch went Off after queueing.
                                          'switched_off')),
  template_code text not null check (template_code ~ '^tn_[a-z_]+_(en|hi)_v[0-9]+$'),
  -- Allowlisted keys per type (authz.cmsg_param_keys); never returned by a staff read.
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  attachment jsonb check (attachment is null or (
    jsonb_typeof(attachment) = 'object' and (attachment - array['source', 'id']) = '{}'::jsonb
    and attachment ->> 'source' in ('purchase_evidence', 'department_evidence')
    and (attachment ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  -- 98xxxxxx12 / p***@example.test; the address itself is resolved at send time.
  to_masked text check (length(to_masked) <= 120),
  not_before timestamptz not null default now(),
  next_attempt_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 4),
  lease_owner text check (length(lease_owner) between 1 and 60),
  lease_until timestamptz,
  provider_message_id text check (length(provider_message_id) between 1 and 200),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  last_error_code text check (last_error_code in ('not_configured', 'rejected', 'provider_error', 'network', 'bad_response',
                                                  'bounced', 'invalid_number', 'expired')),
  rule text not null check (authz.system_rule_ok(rule)),
  resend_of uuid references public.customer_messages (id),
  requested_by uuid references public.staff_profiles (user_id),
  request_id uuid,
  -- clock_timestamp: rows made in one transaction keep their order on the card.
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (deal_id, message_type, channel, event_key),
  unique (channel, provider_message_id),
  unique (deal_id, request_id),
  check ((status in ('skipped', 'stopped')) = (skip_reason is not null)),
  check (status <> 'stopped' or skip_reason = 'opted_out'),
  check ((resend_of is null) = (requested_by is null)),
  check ((resend_of is null) = (request_id is null)),
  check (status not in ('queued', 'sending') or next_attempt_at is not null)
);
create index customer_messages_queue_idx on public.customer_messages (next_attempt_at) where status in ('queued', 'sending');
create index customer_messages_deal_idx on public.customer_messages (deal_id, created_at desc);
create index customer_messages_entity_idx on public.customer_messages (legal_entity_id, status, created_at desc);
create index customer_messages_deal_fk_idx on public.customer_messages (legal_entity_id, branch_id, deal_id);
create index customer_messages_resend_of_idx on public.customer_messages (resend_of) where resend_of is not null;
create index customer_messages_requested_by_idx on public.customer_messages (requested_by) where requested_by is not null;
comment on table public.customer_messages is
  'Customer message queue and log (contract 5.4). One row per event and channel. The address is resolved at send time by customer_message_claim and never stored; params are never returned by a staff read.';

create table public.customer_message_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('resend', 'interakt')),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  message_id uuid references public.customer_messages (id),
  kind text not null check (kind in ('sent', 'delivered', 'read', 'failed', 'bounced', 'complained', 'inbound_stop',
                                     'inbound_start', 'inbound_other')),
  error_code text check (error_code ~ '^[a-z_]{1,40}$'),
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
create index customer_message_events_message_idx on public.customer_message_events (message_id) where message_id is not null;

create table public.customer_whatsapp_optouts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  mobile text not null check (mobile ~ '^[6-9][0-9]{9}$'),
  opted_out_at timestamptz not null default now(),
  source text not null check (source in ('stop_reply', 'staff')),
  event_id uuid references public.customer_message_events (id),
  restarted_at timestamptz,
  restart_source text check (restart_source in ('start_reply', 'staff')),
  restarted_by uuid references public.staff_profiles (user_id),
  restart_event_id uuid references public.customer_message_events (id),
  updated_at timestamptz not null default now(),
  unique (legal_entity_id, mobile),
  check ((restarted_at is null) = (restart_source is null)),
  check ((source = 'stop_reply') = (event_id is not null))
);
create index customer_whatsapp_optouts_event_idx on public.customer_whatsapp_optouts (event_id) where event_id is not null;
create index customer_whatsapp_optouts_restart_event_idx on public.customer_whatsapp_optouts (restart_event_id) where restart_event_id is not null;
create index customer_whatsapp_optouts_restarted_by_idx on public.customer_whatsapp_optouts (restarted_by) where restarted_by is not null;

create table public.customer_message_switches (
  legal_entity_id uuid not null references public.legal_entities (id),
  message_type text not null check (message_type = any (authz.cmsg_types())),
  channel text not null check (channel in ('email', 'whatsapp')),
  enabled boolean not null default false,
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  primary key (legal_entity_id, message_type, channel)
);
create index customer_message_switches_updated_by_idx on public.customer_message_switches (updated_by) where updated_by is not null;

create table public.customer_message_settings (
  legal_entity_id uuid primary key references public.legal_entities (id),
  pilot_only boolean not null default true,
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now()
);
create index customer_message_settings_updated_by_idx on public.customer_message_settings (updated_by) where updated_by is not null;

create table public.customer_message_pilot (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  added_by uuid not null references public.staff_profiles (user_id),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.staff_profiles (user_id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  check ((removed_at is null) = (removed_by is null))
);
create unique index customer_message_pilot_active_idx on public.customer_message_pilot (deal_id) where removed_at is null;
create index customer_message_pilot_deal_fk_idx on public.customer_message_pilot (legal_entity_id, deal_id);
create index customer_message_pilot_added_by_idx on public.customer_message_pilot (added_by);
create index customer_message_pilot_removed_by_idx on public.customer_message_pilot (removed_by) where removed_by is not null;

create table public.whatsapp_templates (
  legal_entity_id uuid not null references public.legal_entities (id),
  template_code text not null check (template_code ~ '^tn_[a-z_]+_(en|hi)_v[0-9]+$'),
  status text not null default 'not_submitted' check (status in ('not_submitted', 'submitted', 'approved', 'rejected')),
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  primary key (legal_entity_id, template_code)
);
create index whatsapp_templates_updated_by_idx on public.whatsapp_templates (updated_by) where updated_by is not null;

-- Track D turns these into notices 43 (message_failed) and 44 (whatsapp_stopped).
create table public.customer_message_alerts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  kind text not null check (kind in ('message_failed', 'whatsapp_stopped')),
  message_id uuid references public.customer_messages (id),
  event_id uuid references public.customer_message_events (id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  check ((kind = 'message_failed') = (message_id is not null)),
  check ((kind = 'whatsapp_stopped') = (event_id is not null))
);
create unique index customer_message_alerts_failed_idx on public.customer_message_alerts (message_id) where kind = 'message_failed';
create unique index customer_message_alerts_stopped_idx on public.customer_message_alerts (deal_id, event_id) where kind = 'whatsapp_stopped';
create index customer_message_alerts_deal_fk_idx on public.customer_message_alerts (legal_entity_id, branch_id, deal_id);
create index customer_message_alerts_event_idx on public.customer_message_alerts (event_id) where event_id is not null;

-- Track D turns these into notice 45 (boarding_pass_due).
create table public.flight_boarding_pass_alerts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  sector_id uuid not null,
  departure_date date not null,
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, sector_id) references public.flight_sectors (task_id, id),
  unique (task_id, sector_id, departure_date)
);
create index flight_boarding_pass_alerts_deal_fk_idx on public.flight_boarding_pass_alerts (legal_entity_id, branch_id, deal_id);
create index flight_boarding_pass_alerts_task_fk_idx on public.flight_boarding_pass_alerts (legal_entity_id, task_id);

-- A failed cmsg_enqueue (it never fails the staff step): counted by task customer_message_health.
create table public.customer_message_enqueue_failures (
  id bigint generated always as identity primary key,
  failed_at timestamptz not null default now(),
  message_type text check (length(message_type) <= 40),
  error_code text not null check (error_code ~ '^[A-Za-z0-9_]{1,40}$')
);
create index customer_message_enqueue_failures_at_idx on public.customer_message_enqueue_failures (failed_at);

-- ===========================================================================
-- 3. Evidence kinds (5.6)
-- ===========================================================================

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.purchase_evidence'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%kind%' and pg_get_constraintdef(con.oid) like '%supplier_confirmation%'
  loop
    execute format('alter table public.purchase_evidence drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.purchase_evidence
  add constraint purchase_evidence_kind_check
    check (kind in ('quote', 'supplier_confirmation', 'other', 'customer_voucher')),
  add column customer_ready_at timestamptz,
  add column customer_ready_by uuid references public.staff_profiles (user_id),
  add constraint purchase_evidence_customer_ready_check check (
    (customer_ready_at is null) = (customer_ready_by is null)
    and (customer_ready_at is null or (kind = 'customer_voucher' and status = 'stored')));
create index purchase_evidence_customer_ready_by_idx on public.purchase_evidence (customer_ready_by) where customer_ready_by is not null;

alter table public.department_evidence drop constraint department_evidence_kind_check;
alter table public.department_evidence add constraint department_evidence_kind_check
  check (kind in ('applicant_document', 'fee_receipt', 'authority_outcome', 'direct_payment_proof', 'other', 'e_ticket',
                  'boarding_pass'));

-- ===========================================================================
-- 4. Guards
-- ===========================================================================

create function authz.cmsg_no_delete_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name using errcode = '42501';
end;
$$;

create function authz.cmsg_append_only_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

-- Status moves forward only: queued -> sending -> sent -> delivered -> read;
-- queued, sending or sent -> failed; queued or sending -> skipped / stopped
-- (re-check at claim, STOP); sending -> queued only as a scheduled retry
-- (attempts grew). The event, content and Deal are immutable.
create function authz.customer_messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'customer messages cannot be deleted' using errcode = '42501';
  end if;
  if (new.id, new.legal_entity_id, new.branch_id, new.deal_id, new.message_type, new.channel, new.language, new.event_key,
      new.params, new.attachment, new.template_code, new.rule, new.resend_of, new.requested_by, new.request_id, new.created_at)
     is distinct from
     (old.id, old.legal_entity_id, old.branch_id, old.deal_id, old.message_type, old.channel, old.language, old.event_key,
      old.params, old.attachment, old.template_code, old.rule, old.resend_of, old.requested_by, old.request_id, old.created_at) then
    raise exception 'customer message content is immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'queued' and new.status in ('sending', 'failed', 'skipped', 'stopped'))
    or (old.status = 'sending' and new.status in ('sent', 'failed', 'skipped', 'stopped'))
    or (old.status = 'sending' and new.status = 'queued' and new.attempts > 0)
    or (old.status = 'sent' and new.status in ('delivered', 'read', 'failed'))
    or (old.status = 'delivered' and new.status = 'read')) then
    raise exception 'customer message status cannot move from % to %', old.status, new.status using errcode = '42501';
  end if;
  if old.status in ('failed', 'skipped', 'stopped', 'read') and (to_jsonb(new) - array['updated_at', 'row_version'])
       is distinct from (to_jsonb(old) - array['updated_at', 'row_version']) then
    raise exception 'a finished customer message is frozen' using errcode = '42501';
  end if;
  new.updated_at := now();
  if new.status is distinct from old.status then
    new.row_version := old.row_version + 1;
  end if;
  return new;
end;
$$;

create trigger customer_messages_a_guard before update or delete on public.customer_messages
  for each row execute function authz.customer_messages_guard();
create trigger deal_message_prefs_a_guard before delete on public.deal_message_prefs
  for each row execute function authz.cmsg_no_delete_guard();
create trigger customer_whatsapp_optouts_a_guard before delete on public.customer_whatsapp_optouts
  for each row execute function authz.cmsg_no_delete_guard();
create trigger customer_message_events_a_guard before update or delete on public.customer_message_events
  for each row execute function authz.cmsg_append_only_guard();
create trigger customer_message_switches_a_guard before delete on public.customer_message_switches
  for each row execute function authz.cmsg_no_delete_guard();
create trigger customer_message_settings_a_guard before delete on public.customer_message_settings
  for each row execute function authz.cmsg_no_delete_guard();
create trigger customer_message_pilot_a_guard before delete on public.customer_message_pilot
  for each row execute function authz.cmsg_no_delete_guard();
create trigger whatsapp_templates_a_guard before delete on public.whatsapp_templates
  for each row execute function authz.cmsg_no_delete_guard();
create trigger customer_message_alerts_a_guard before update or delete on public.customer_message_alerts
  for each row execute function authz.cmsg_append_only_guard();
create trigger flight_boarding_pass_alerts_a_guard before update or delete on public.flight_boarding_pass_alerts
  for each row execute function authz.cmsg_append_only_guard();

-- Failures older than 30 days may be pruned (by the health task only).
create function authz.cmsg_failures_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' or old.failed_at >= now() - interval '30 days' then
    raise exception 'enqueue failures are append-only' using errcode = '42501';
  end if;
  return old;
end;
$$;
create trigger customer_message_enqueue_failures_a_guard before update or delete on public.customer_message_enqueue_failures
  for each row execute function authz.cmsg_failures_guard();

-- Settings audit (5.9): column names only, never values.
create trigger customer_message_switches_audit after insert or update on public.customer_message_switches
  for each row execute function authz.audit_settings_columns('settings.messages_changed', 'enabled');
create trigger customer_message_settings_audit after insert or update on public.customer_message_settings
  for each row execute function authz.audit_settings_columns('settings.messages_changed', 'pilot_only');
create trigger whatsapp_templates_audit after insert or update on public.whatsapp_templates
  for each row execute function authz.audit_settings_columns('settings.messages_changed', 'status');
create trigger customer_message_switches_no_truncate before truncate on public.customer_message_switches
  for each statement execute function authz.refuse_settings_truncate();
create trigger customer_message_settings_no_truncate before truncate on public.customer_message_settings
  for each statement execute function authz.refuse_settings_truncate();
create trigger whatsapp_templates_no_truncate before truncate on public.whatsapp_templates
  for each statement execute function authz.refuse_settings_truncate();
create trigger customer_messages_no_truncate before truncate on public.customer_messages
  for each statement execute function authz.refuse_settings_truncate();

-- ===========================================================================
-- 5. Seeds: 18 switches Off, pilot list On, 18 templates not submitted
-- ===========================================================================

create function authz.cmsg_seed(p_entity uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
  v_total integer := 0;
begin
  insert into public.customer_message_switches (legal_entity_id, message_type, channel)
  select p_entity, t.t, c.c from unnest(authz.cmsg_types()) t(t) cross join unnest(array['email', 'whatsapp']) c(c)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;
  insert into public.customer_message_settings (legal_entity_id) values (p_entity) on conflict do nothing;
  insert into public.whatsapp_templates (legal_entity_id, template_code)
  select p_entity, authz.cmsg_template_code(t.t, l.l) from unnest(authz.cmsg_types()) t(t) cross join unnest(array['en', 'hi']) l(l)
  on conflict do nothing;
  return v_total;
end;
$$;

create function authz.cmsg_seed_entity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.cmsg_seed(new.id);
  return null;
end;
$$;
create trigger legal_entities_cmsg_seed after insert on public.legal_entities
  for each row execute function authz.cmsg_seed_entity();

select authz.cmsg_seed(e.id) from public.legal_entities e;

-- ===========================================================================
-- 6. Contact, skip rules and enqueue (5.5)
-- ===========================================================================

-- The Deal's booking contact (confirmed version, contact_confirmed) overlaid
-- by the Deal's message preferences. Never leaves the definer functions.
create function authz.cmsg_contact(p_deal uuid)
returns table (version_id uuid, confirmed boolean, customer_name text, email text, mobile text, language text,
               email_off boolean, whatsapp_off boolean)
language sql stable security definer set search_path = '' as $$
  select v.id,
         coalesce(c.contact_confirmed, false),
         c.contact_name,
         case when c.contact_confirmed then coalesce(p.email_override, c.email) end,
         case when c.contact_confirmed then coalesce(p.whatsapp_mobile, c.mobile) end,
         coalesce(p.language, 'en'),
         coalesce(p.email_off, false),
         coalesce(p.whatsapp_off, false)
  from (select 1) one
  left join lateral (select bv.id from public.booking_versions bv
                     where bv.deal_id = p_deal and bv.status = 'confirmed'
                     order by bv.version_no desc limit 1) v on true
  left join public.booking_version_contacts c on c.booking_version_id = v.id
  left join public.deal_message_prefs p on p.deal_id = p_deal
$$;

create function authz.cmsg_opted_out(p_entity uuid, p_mobile text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.customer_whatsapp_optouts o
                 where o.legal_entity_id = p_entity and o.mobile = p_mobile and o.restarted_at is null)
$$;

-- A live change request on the Deal (track G replaces B's authz.deal_change_open).
create function authz.cmsg_change_open(p_deal uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean;
begin
  if to_regprocedure('authz.deal_change_open(uuid)') is null then
    return false;
  end if;
  execute 'select authz.deal_change_open($1)' into v using p_deal;
  return coalesce(v, false);
end;
$$;

create function authz.cmsg_switch_on(p_entity uuid, p_type text, p_channel text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.enabled from public.customer_message_switches s
                   where s.legal_entity_id = p_entity and s.message_type = p_type and s.channel = p_channel), false)
$$;

-- Any channel of the type On for the entity (cheap pre-check for triggers).
create function authz.cmsg_type_on(p_entity uuid, p_type text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.customer_message_switches s
                 where s.legal_entity_id = p_entity and s.message_type = p_type and s.enabled)
$$;

-- The first skip reason in the 5.5 order, or null when the message may go.
create function authz.cmsg_skip_reason(p_deal uuid, p_type text, p_channel text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  c record;
  v_pilot_only boolean;
begin
  select * into v_deal from public.deals d where d.id = p_deal;
  if v_deal.is_synthetic then
    return 'test_deal';
  end if;
  v_pilot_only := coalesce((select s.pilot_only from public.customer_message_settings s
                            where s.legal_entity_id = v_deal.legal_entity_id), true);
  if v_pilot_only and not exists (select 1 from public.customer_message_pilot p
                                  where p.deal_id = p_deal and p.removed_at is null) then
    return 'not_in_pilot';
  end if;
  if authz.deal_trip_cancelled(p_deal) then
    return 'trip_cancelled';
  end if;
  if p_type = 'trip_reminder' and authz.cmsg_change_open(p_deal) then
    return 'change_in_progress';
  end if;
  select * into c from authz.cmsg_contact(p_deal);
  if (p_channel = 'email' and c.email_off) or (p_channel = 'whatsapp' and c.whatsapp_off) then
    return 'channel_off_on_deal';
  end if;
  if not coalesce(c.confirmed, false)
     or (p_channel = 'email' and c.email is null) or (p_channel = 'whatsapp' and c.mobile is null) then
    return 'no_contact';
  end if;
  if p_channel = 'whatsapp' and authz.cmsg_opted_out(v_deal.legal_entity_id, c.mobile) then
    return 'opted_out';
  end if;
  if p_channel = 'whatsapp' and coalesce((select t.status from public.whatsapp_templates t
        where t.legal_entity_id = v_deal.legal_entity_id
          and t.template_code = authz.cmsg_template_code(p_type, c.language)), 'not_submitted') <> 'approved' then
    return 'template_not_approved';
  end if;
  return null;
end;
$$;

-- Base params from the Deal's confirmed booking (strings only).
create function authz.cmsg_base_params(p_deal uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'customerName', c.customer_name,
    'dealReference', d.reference,
    'destination', coalesce(v.trip_destination, v.city, v.hotel_name),
    'tripStart', authz.cmsg_date(coalesce(v.trip_start, v.check_in)),
    'tripEnd', authz.cmsg_date(coalesce(v.trip_end, v.check_out)),
    'travellerCount', coalesce(v.pax_total, nullif(coalesce(v.adults, 0) + coalesce(v.children, 0), 0),
                               (select count(*) from public.booking_version_travellers t where t.booking_version_id = v.id))::text))
  from public.deals d
  left join lateral authz.cmsg_contact(d.id) c on true
  left join public.booking_versions v on v.id = c.version_id
  where d.id = p_deal
$$;

-- The queueing core. p_channels null = both. Returns the number of rows made.
create function authz.cmsg_enqueue_core(
  p_deal uuid, p_type text, p_event_key text, p_params jsonb, p_attachment jsonb,
  p_channels text[], p_rule text, p_resend_of uuid, p_requested_by uuid, p_request_id uuid
) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_channel text;
  v_reason text;
  v_params jsonb;
  v_keys text[] := authz.cmsg_param_keys(p_type);
  c record;
  v_status text;
  v_n integer;
  v_total integer := 0;
  v_now timestamptz := now();
begin
  if p_type is null or not (p_type = any (authz.cmsg_types())) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'type';
  end if;
  if p_event_key is null or length(p_event_key) not between 1 and 120 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'event_key';
  end if;
  if p_params is not null and jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'params';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal;
  if v_deal.id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'deal';
  end if;

  -- Allowlisted keys only; values as strings. The base params read from the
  -- confirmed booking win over caller values.
  select coalesce(jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'string' then e.value
                                                 else to_jsonb(e.value #>> '{}') end), '{}'::jsonb)
    into v_params
  from jsonb_each(coalesce(p_params, '{}'::jsonb) || authz.cmsg_base_params(p_deal)) e
  where e.key = any (v_keys) and jsonb_typeof(e.value) in ('string', 'number');

  select * into c from authz.cmsg_contact(p_deal);

  foreach v_channel in array coalesce(p_channels, array['email', 'whatsapp']) loop
    -- LD6: switch Off = nothing at all.
    continue when not authz.cmsg_switch_on(v_deal.legal_entity_id, p_type, v_channel);
    v_reason := authz.cmsg_skip_reason(p_deal, p_type, v_channel);
    v_status := case when v_reason is null then 'queued' when v_reason = 'opted_out' then 'stopped' else 'skipped' end;
    insert into public.customer_messages (legal_entity_id, branch_id, deal_id, message_type, channel, language, event_key,
      status, skip_reason, template_code, params, attachment, to_masked, not_before, next_attempt_at, rule,
      resend_of, requested_by, request_id)
    values (v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, p_type, v_channel, c.language, p_event_key,
      v_status, v_reason, authz.cmsg_template_code(p_type, c.language), v_params, p_attachment,
      case v_channel when 'email' then authz.cmsg_mask_email(c.email) else authz.cmsg_mask_mobile(c.mobile) end,
      authz.cmsg_not_before(p_type, v_now),
      case when v_status = 'queued' then authz.cmsg_not_before(p_type, v_now) end,
      coalesce(p_rule, 'cmsg_' || p_type), p_resend_of, p_requested_by, p_request_id)
    on conflict (deal_id, message_type, channel, event_key) do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end;
$$;

-- Counts a failed enqueue; never raises.
create function authz.cmsg_note_failure(p_type text, p_code text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    insert into public.customer_message_enqueue_failures (message_type, error_code)
    values (left(p_type, 40), coalesce(nullif(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9_]', '', 'g'), ''), 'unknown'));
    update public.timer_tasks t set last_error_code = 'enqueue_failed' where t.name = 'customer_message_health';
  exception when others then
    null;
  end;
end;
$$;

-- FROZEN (contract 5.5): queues one message per channel for an event. Never
-- fails the staff step that caused it (plan C12): any error is counted and 0
-- is returned.
create function authz.cmsg_enqueue(p_deal uuid, p_type text, p_event_key text, p_params jsonb, p_attachment jsonb)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  begin
    v_n := authz.cmsg_enqueue_core(p_deal, p_type, p_event_key, p_params, p_attachment, null, null, null, null, null);
  exception when others then
    perform authz.cmsg_note_failure(p_type, sqlstate);
    return 0;
  end;
  return v_n;
end;
$$;

-- Timer task customer_message_health (hourly): enqueue failures of the last
-- 24 hours; prunes failures older than 30 days.
create function authz.customer_message_health() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  delete from public.customer_message_enqueue_failures f where f.failed_at < now() - interval '30 days';
  select count(*)::integer into v_n from public.customer_message_enqueue_failures f where f.failed_at >= now() - interval '24 hours';
  return jsonb_build_object('enqueueFailures24h', v_n);
end;
$$;
select authz.timer_task_register('customer_message_health', 'authz.customer_message_health', 60);

-- ===========================================================================
-- 7. RLS and privileges
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['deal_message_prefs', 'customer_messages', 'customer_message_events', 'customer_whatsapp_optouts',
    'customer_message_switches', 'customer_message_settings', 'customer_message_pilot', 'whatsapp_templates',
    'customer_message_alerts', 'flight_boarding_pass_alerts', 'customer_message_enqueue_failures'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy require_valid_session on public.%I as restrictive for all to authenticated
      using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function
  authz.cmsg_types(), authz.cmsg_quiet(text), authz.cmsg_param_keys(text), authz.cmsg_template_code(text, text),
  authz.cmsg_not_before(text, timestamptz), authz.cmsg_mask_mobile(text), authz.cmsg_mask_email(text), authz.cmsg_date(date),
  authz.cmsg_no_delete_guard(), authz.cmsg_append_only_guard(), authz.customer_messages_guard(), authz.cmsg_failures_guard(),
  authz.cmsg_seed(uuid), authz.cmsg_seed_entity(), authz.cmsg_contact(uuid), authz.cmsg_opted_out(uuid, text),
  authz.cmsg_change_open(uuid), authz.cmsg_switch_on(uuid, text, text), authz.cmsg_type_on(uuid, text),
  authz.cmsg_skip_reason(uuid, text, text), authz.cmsg_base_params(uuid),
  authz.cmsg_enqueue_core(uuid, text, text, jsonb, jsonb, text[], text, uuid, uuid, uuid),
  authz.cmsg_note_failure(text, text), authz.cmsg_enqueue(uuid, text, text, jsonb, jsonb), authz.customer_message_health()
from public, anon, authenticated, service_role;

commit;
