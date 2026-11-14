-- SYNTHETIC Accounts phase 3 volume for local speed measurements only
-- (contract accounts-phase3-2026-11-12, section 16.5; plan §9).
-- Run AFTER scripts/perf/accounts-volume.sql (10,000 SYN-PERF Deals) and
-- scripts/perf/accounts2-volume.sql (documents, refunds, 3,000 suppliers and
-- hotels) on a disposable LOCAL stack that has every Phase 3 migration
-- (20261205000100..0899):
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/accounts3-volume.sql
-- Smaller validation run: PGOPTIONS='-c perf.scale=0.01'.
--
-- Adds (16.5): 30,000 customer messages (nine types × two channels, every
-- status, with delivery events); 2,000 rate contracts with 40,000 rate lines
-- (and room types, blackouts); 500 change requests with 800 reconfirmations
-- (and task confirmation history); 3,000 push devices (at most 10 active per
-- person, the rest removed); 5,000 write-offs (every status); 20,000 Tally
-- XML lines in 20 XML files (left-out lists, xml columns on tally_records);
-- plus 500 held and 200 ready automatic bill drafts for "Bills to check".
-- Synthetic values only (SYN-PERF-…, @example.test, 60000xxxxx numbers,
-- masked addresses). The notices switch is off while seeding (restored at the
-- end), so no notice or push job is written by a trigger. Same guards as
-- accounts-volume.sql; refuses a second run.
--
-- Written by Track T from the contract, before the tracks' migrations
-- landed: every column name not printed in the contract is marked
-- "-- ASSUMPTION:" and is the first thing to check when the seed fails.
do $$
begin
  if (select environment from public.deployment_settings limit 1) is distinct from 'test' then
    raise exception 'accounts3-volume.sql runs only on a synthetic (test) database';
  end if;
  if not exists (select 1 from public.legal_entities where code = 'SYNTHETIC_B' and is_synthetic)
     or not exists (select 1 from public.integration_intake_config
                    where id = 'c0000000-0000-4000-8000-000000000001' and portal_domain = 'synthetic-portal.example.test') then
    raise exception 'accounts3-volume.sql runs only on a database seeded with the synthetic fixtures (scripts/seed-local.mjs)';
  end if;
  if (select count(*) from public.deals where reference like 'SYN-PERF-%') < 100 then
    raise exception 'run scripts/perf/accounts-volume.sql first (SYN-PERF Deals missing)';
  end if;
  if not exists (select 1 from public.suppliers where source_ref like 'PERF:S-%') then
    raise exception 'run scripts/perf/accounts2-volume.sql first (Phase 2 suppliers and hotels missing)';
  end if;
  if to_regclass('public.customer_messages') is null or to_regclass('public.rate_contracts') is null
     or to_regclass('public.booking_change_requests') is null or to_regclass('public.staff_push_devices') is null
     or to_regclass('public.deal_write_offs') is null or to_regclass('public.tally_export_left_out') is null then
    raise exception 'accounts3-volume.sql needs every Phase 3 migration (20261205000100..0899) applied first';
  end if;
  if exists (select 1 from public.rate_contracts where note = 'SYN-PERF rate contract') then
    raise exception 'accounts3-volume.sql already ran on this database; reset the local stack first';
  end if;
end $$;

begin;
set local lock_timeout = '15s';
select set_config('perf.scale', coalesce(nullif(current_setting('perf.scale', true), ''), '1'), true);
create or replace function pg_temp.n(p integer) returns integer language sql immutable as
  $$ select greatest(1, (p * current_setting('perf.scale')::numeric)::integer) $$;
create or replace function pg_temp.h(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

create temporary table perf3_switch on commit drop as select notices_enabled from public.notice_settings where id;
update public.notice_settings set notices_enabled = false where id;

create temporary table perf3_ctx on commit drop as
select e.id as entity_id,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.11@example.test') as acc1,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.12@example.test') as acc2,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.19@example.test') as purchase,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.20@example.test') as purchase2,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.16@example.test') as manager,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.17@example.test') as manager2
from public.legal_entities e where e.code = 'HOLIDAY_CHACHA';

-- The SYN-PERF Deals in seed order: confirmed version, hotel task (Purchase), flight task, owner.
create temporary table perf3_deals on commit drop as
select row_number() over (order by d.reference) as n, d.id as deal_id, d.branch_id, d.reference, d.owner_user_id as owner_id, d.created_at,
       v.id as version_id, c.selling_total_paise as selling,
       (select t.id from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'purchase' order by t.created_at, t.id limit 1) as hotel_task,
       (select t.service_item_id from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'purchase' order by t.created_at, t.id limit 1) as hotel_item,
       (select t.id from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'flight' order by t.created_at, t.id limit 1) as flight_task,
       (select t.service_item_id from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'flight' order by t.created_at, t.id limit 1) as flight_item
from public.deals d
join public.booking_versions v on v.deal_id = d.id and v.version_no = 1
join public.booking_version_commercials c on c.version_id = v.id
where d.reference like 'SYN-PERF-%';
analyze perf3_deals;

-- Trip dates on the SYN-PERF versions (the Phase 1 seed left them empty): small balances need "trip ended", reminders need
-- "trip start". The version guard refuses any edit of a confirmed version, so this one seed-only update runs with
-- triggers off (session_replication_role = replica, this statement only): only the two date columns change, the
-- content hash the reviews point at stays as it was, and no prefill job is queued.
set local session_replication_role = replica;
update public.booking_versions v set trip_start = (d.created_at + interval '10 days')::date, trip_end = (d.created_at + interval '14 days')::date
from perf3_deals d where v.id = d.version_id and v.trip_start is null;
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------
-- 1. 30,000 customer messages (5.4) + delivery events
-- ---------------------------------------------------------------------------
-- Message prefs for every tenth Deal (Hindi on every fifth of those, one opted-out number on every 50th).
insert into public.deal_message_prefs (deal_id, legal_entity_id, branch_id, language, whatsapp_mobile, whatsapp_off, email_off, off_reason, updated_by)
select d.deal_id, c.entity_id, d.branch_id, case when d.n % 50 = 0 then 'hi' else 'en' end,
       '60000' || lpad((d.n % 100000)::text, 5, '0'),
       false, d.n % 200 = 0, case when d.n % 200 = 0 then 'Synthetic perf: customer asked for no e-mail' end, d.owner_id
from perf3_deals d cross join perf3_ctx c where d.n % 10 = 0;
-- ASSUMPTION: deal_message_prefs.updated_by is required; row_version / created_at / updated_at have defaults.
insert into public.customer_whatsapp_optouts (legal_entity_id, mobile, opted_out_at, source, event_id)
select c.entity_id, '60000' || lpad((d.n % 100000)::text, 5, '0'), now() - interval '3 days', 'staff', null
from perf3_deals d cross join perf3_ctx c where d.n % 500 = 0;

create temporary table perf3_msgs on commit drop as
select g as n, gen_random_uuid() as id,
       d.deal_id, d.branch_id, d.n as deal_n,
       (array['booking_confirmed', 'payment_received', 'hotel_voucher', 'e_ticket', 'boarding_pass', 'visa_status', 'trip_reminder', 'refund_paid',
              'booking_changed'])[1 + (g % 9)] as message_type,
       case when (g / 9) % 2 = 0 then 'email' else 'whatsapp' end as channel,
       case when d.n % 50 = 0 then 'hi' else 'en' end as language,
       -- Mostly delivered history; a working queue of about 1% queued and a few failures and skips.
       case when g % 100 = 0 then 'queued' when g % 100 = 1 then 'failed' when g % 100 = 2 then 'skipped' when g % 100 = 3 then 'stopped'
            when g % 10 < 5 then 'delivered' when g % 10 < 8 then 'read' else 'sent' end as status,
       now() - ((g % 2000) || ' minutes')::interval - ((g % 300) || ' days')::interval as created_at
from generate_series(1, pg_temp.n(30000)) g
join perf3_deals d on d.n = 1 + ((g / 18) % (select count(*) from perf3_deals));
insert into public.customer_messages (id, legal_entity_id, branch_id, deal_id, message_type, channel, language, event_key, status, skip_reason,
  template_code, params, attachment, to_masked, not_before, next_attempt_at, attempts, provider_message_id, sent_at, delivered_at, read_at, failed_at,
  last_error_code, rule, created_at, updated_at)
select m.id, c.entity_id, m.branch_id, m.deal_id, m.message_type, m.channel, m.language,
       -- once per event and channel: the seed number keeps (deal, type, channel, event_key) unique.
       case m.message_type when 'booking_confirmed' then 'deal' when 'trip_reminder' then 'd3:perf' || m.n else 'perf:' || m.n end,
       m.status,
       case m.status when 'skipped' then (array['not_in_pilot', 'no_contact', 'channel_off_on_deal', 'template_not_approved'])[1 + (m.n % 4)]
                     when 'stopped' then 'opted_out' end,
       'tn_' || m.message_type || '_' || m.language || '_v1',
       case m.message_type
         when 'payment_received' then jsonb_build_object('customerName', 'Synthetic Perf Customer', 'dealReference', 'SYN-PERF', 'amountPaise', '100000',
                                                          'balancePaise', '0')
         when 'refund_paid' then jsonb_build_object('customerName', 'Synthetic Perf Customer', 'dealReference', 'SYN-PERF', 'amountPaise', '1000')
         else jsonb_build_object('customerName', 'Synthetic Perf Customer', 'dealReference', 'SYN-PERF') end,
       null,
       case m.channel when 'email' then 'p***@example.test' else '60xxxxxx' || lpad((m.deal_n % 100)::text, 2, '0') end,
       m.created_at,
       case when m.status in ('queued') then m.created_at end,
       case m.status when 'queued' then 0 when 'failed' then 4 when 'skipped' then 0 when 'stopped' then 0 else 1 end,
       case when m.status in ('sent', 'delivered', 'read', 'failed') and m.status <> 'failed' then 'SYNPERF-' || m.channel || '-' || m.n end,
       case when m.status in ('sent', 'delivered', 'read') then m.created_at + interval '20 seconds' end,
       case when m.status in ('delivered', 'read') then m.created_at + interval '40 seconds' end,
       case when m.status = 'read' then m.created_at + interval '5 minutes' end,
       case when m.status = 'failed' then m.created_at + interval '65 minutes' end,
       case when m.status = 'failed' then (array['provider_error', 'network', 'invalid_number', 'bounced'])[1 + (m.n % 4)] end,
       case m.message_type when 'trip_reminder' then 'customer_trip_reminders' else 'perf_seed' end,
       m.created_at, m.created_at + interval '5 minutes'
from perf3_msgs m cross join perf3_ctx c;
-- ASSUMPTION: updated_at / row_version have defaults or accept these values; status checks allow the timestamps above
-- (sent_at for sent and later, failed_at for failed). rule 'perf_seed' matches ^[a-z][a-z0-9_.]{2,59}$.
insert into public.customer_message_events (provider, provider_event_id, message_id, kind, error_code, received_at)
select case m.channel when 'email' then 'resend' else 'interakt' end, 'SYNPERF-EV-' || m.n || '-' || k.kind, m.id, k.kind, null,
       m.created_at + interval '40 seconds'
from perf3_msgs m cross join (values ('sent'), ('delivered')) k(kind) where m.status in ('delivered', 'read');
-- Pilot list: the first 50 Deals (pilot_only stays as the migration left it).
insert into public.customer_message_pilot (legal_entity_id, deal_id, added_by, added_at)
select c.entity_id, d.deal_id, (select user_id from public.staff_profiles where work_email = 'admin.jodhpur@example.test'), now() - interval '10 days'
from perf3_deals d cross join perf3_ctx c where d.n <= 50;
analyze public.customer_messages, public.customer_message_events, public.deal_message_prefs, public.customer_whatsapp_optouts, public.customer_message_pilot;

-- ---------------------------------------------------------------------------
-- 2. 2,000 rate contracts, 40,000 rate lines (9.1)
-- ---------------------------------------------------------------------------
-- Room types: three per contracted hotel.
create temporary table perf3_pairs on commit drop as
select row_number() over (order by s.source_ref, h.id) as n, s.id as supplier_id, h.hotel_id
from public.supplier_hotels h join public.suppliers s on s.id = h.supplier_id
where s.source_ref like 'PERF:S-%';
create temporary table perf3_rc on commit drop as
select p.n, p.supplier_id, p.hotel_id, gen_random_uuid() as id,
       case when p.n % 20 = 0 then 'pending_approval' when p.n % 20 = 1 then 'draft' when p.n % 20 = 2 then 'returned' when p.n % 20 = 3 then 'ended'
            else 'active' end as status,
       -- Validity: a one-year span; about 5% end within 30 days (the "ending soon" preset and expiry alerts).
       case when p.n % 20 = 4 then current_date - 340 else current_date - (p.n % 200)::integer end as valid_from
from perf3_pairs p where p.n <= pg_temp.n(2000);
create temporary table perf3_rt on commit drop as
select distinct on (x.hotel_id, k) x.hotel_id, k, gen_random_uuid() as id,
       (array['Deluxe Room', 'Premium Room', 'Family Suite'])[k] as name
from perf3_rc x cross join generate_series(1, 3) k;
insert into public.hotel_room_types (id, legal_entity_id, hotel_id, name, status, created_by, updated_by)
select r.id, c.entity_id, r.hotel_id, r.name, 'active', c.purchase, c.purchase from perf3_rt r cross join perf3_ctx c;
-- ASSUMPTION: hotel_room_types.name_key is generated; row_version / created_at default.
-- Contracts are entered as drafts (rate lines and blackouts change only while a contract is a draft), then moved
-- through the guarded status steps: sent for approval, approved or returned, ended.
insert into public.rate_contracts (id, legal_entity_id, supplier_id, hotel_id, contract_no, version_no, valid_from, valid_to, cancellation_terms, note,
  status, source, entered_by, entered_at)
select x.id, c.entity_id, x.supplier_id, x.hotel_id, 'RC-2026-' || lpad((700000 + x.n)::text, 6, '0'), 1, x.valid_from, x.valid_from + 364,
       'Synthetic perf terms: free cancellation up to 7 days before check-in.', 'SYN-PERF rate contract',
       'draft', 'manual', c.purchase, now() - interval '30 days'
from perf3_rc x cross join perf3_ctx c;
-- ASSUMPTION: rate contract counter table name and columns (rate_contract_counters (legal_entity_id, year, last_no)).
do $$
begin
  if to_regclass('public.rate_contract_counters') is not null then
    insert into public.rate_contract_counters (legal_entity_id, year, last_no)
    select legal_entity_id, 2026, 700000 + count(*) from public.rate_contracts where note = 'SYN-PERF rate contract' group by legal_entity_id
    on conflict do nothing;
  end if;
end $$;
-- 20 lines per contract: 3 room types × (EP/CP/MAP) in two seasons, + 2 AI lines; seasons inside validity, no overlap per room + meal.
insert into public.rate_contract_lines (legal_entity_id, contract_id, line_no, season_from, season_to, room_type_id, meal_plan, rate_paise,
  weekend_rate_paise, extra_adult_paise, child_with_bed_paise, child_without_bed_paise, note)
select (select entity_id from perf3_ctx), z.contract_id, row_number() over (partition by z.contract_id order by z.season_from, z.room_type_id, z.meal_plan)::integer,
       z.season_from, z.season_to, z.room_type_id, z.meal_plan, z.rate_paise, z.weekend_rate_paise, z.extra_adult_paise, z.child_with_bed_paise,
       z.child_without_bed_paise, z.note
from (
select x.id as contract_id,
       case when s.season = 1 then x.valid_from else x.valid_from + 182 end as season_from,
       case when s.season = 1 then x.valid_from + 181 else x.valid_from + 364 end as season_to,
       rt.id as room_type_id, m.code as meal_plan,
       (400000 + (x.n % 50) * 1000 + rt.k * 50000 + m.ord * 25000 + s.season * 30000)::bigint as rate_paise,
       case when x.n % 3 = 0 then (450000 + (x.n % 50) * 1000 + rt.k * 50000)::bigint end as weekend_rate_paise,
       150000 as extra_adult_paise, 100000 as child_with_bed_paise, case when x.n % 2 = 0 then 50000 end as child_without_bed_paise,
       null::text as note
from perf3_rc x
join perf3_rt rt on rt.hotel_id = x.hotel_id
cross join (values (1), (2)) s(season)
cross join (values ('EP', 1), ('CP', 2), ('MAP', 3)) m(code, ord)
union all
select x.id, x.valid_from, x.valid_from + 364, rt.id, 'AI', (900000 + rt.k * 50000)::bigint, null, 200000, 150000, null, 'Synthetic perf all inclusive'
from perf3_rc x join perf3_rt rt on rt.hotel_id = x.hotel_id and rt.k in (1, 2)
) z;
insert into public.rate_contract_blackouts (legal_entity_id, contract_id, from_date, to_date)
select (select entity_id from perf3_ctx), x.id, x.valid_from + 300, x.valid_from + 302 from perf3_rc x where x.n % 5 = 0;
-- Status steps (the guard allows draft -> pending_approval -> active | returned, active -> ended).
update public.rate_contracts r set status = 'pending_approval', submitted_at = now() - interval '29 days'
from perf3_rc x where r.id = x.id and x.status <> 'draft';
update public.rate_contracts r set status = case x.status when 'returned' then 'returned' else 'active' end,
  decided_by = (select manager from perf3_ctx), decided_at = now() - interval '28 days',
  return_reason = case when x.status = 'returned' then 'Synthetic perf: check the weekend rates' end
from perf3_rc x where r.id = x.id and x.status in ('active', 'returned', 'ended');
update public.rate_contracts r set status = 'ended', ended_by = (select manager from perf3_ctx), ended_at = now() - interval '2 days',
  end_reason = 'Synthetic perf: contract ended early'
from perf3_rc x where r.id = x.id and x.status = 'ended';
insert into public.rate_contract_alerts (legal_entity_id, contract_id, days_left)
select (select entity_id from perf3_ctx), x.id, 30 from perf3_rc x where x.status = 'active' and x.n % 20 = 4;
analyze public.hotel_room_types, public.rate_contracts, public.rate_contract_lines, public.rate_contract_blackouts, public.rate_contract_alerts;

-- ---------------------------------------------------------------------------
-- 3. 500 change requests, 800 reconfirmations, confirmation history (10.2)
-- ---------------------------------------------------------------------------
-- Deals 2001..2400 (beyond the Phase 2 documents' busiest range); 100 of them carry an earlier applied request too.
create temporary table perf3_cr on commit drop as
select g as n, gen_random_uuid() as id, d.deal_id, d.branch_id, d.version_id, d.owner_id, d.hotel_task, d.hotel_item, d.flight_task, d.flight_item,
       case when g > 400 then 'applied'                                 -- the earlier, applied request of 100 Deals
            when g % 8 = 0 then 'requested' when g % 8 = 1 then 'approved' when g % 8 = 2 then 'submitted' when g % 8 = 3 then 'returned'
            when g % 8 = 4 then 'not_possible' when g % 8 = 5 then 'withdrawn' else 'applied' end as status,
       now() - ((g % 60) || ' days')::interval - case when g > 400 then interval '90 days' else interval '0' end as requested_at
from generate_series(1, pg_temp.n(500)) g
join perf3_deals d on d.n = 2000 + case when g > 400 then g - 400 else g end;
-- Submitted and applied requests point at their change version (check). The seed stores those versions as discarded
-- drafts that revise the base version (a confirmed change version would need the base superseded and its own
-- commercials, plan and reviews); change history therefore lists the base version only for these Deals.
create temporary table perf3_cv on commit drop as
select x.id as cr_id, gen_random_uuid() as version_id, x.deal_id, x.branch_id, x.version_id as base_id, x.owner_id, x.requested_at,
       1 + row_number() over (partition by x.deal_id order by x.requested_at, x.n) as version_no
from perf3_cr x where x.status in ('submitted', 'applied');
insert into public.booking_versions (id, deal_id, legal_entity_id, branch_id, version_no, service_type, status, content_hash, created_by, created_at,
  revises_version_id, discarded_at, discarded_by)
select v.version_id, v.deal_id, c.entity_id, v.branch_id, v.version_no, 'package', 'discarded', pg_temp.h('perf-cv-' || v.cr_id), v.owner_id,
       v.requested_at + interval '1 hour', v.base_id, v.requested_at + interval '1 day', v.owner_id
from perf3_cv v cross join perf3_ctx c;
insert into public.booking_change_requests (id, legal_entity_id, branch_id, deal_id, ref_no, kind, base_version_id, item_ids, change_summary, reason,
  status, requested_as, change_version_id, requested_by, requested_at, request_id, decided_by, decided_at, decision_request_id, return_reason,
  submitted_by, submitted_at, applied_at, closed_by, closed_at, close_reason)
select x.id, c.entity_id, x.branch_id, x.deal_id, 'CR-2026-' || lpad((600000 + x.n)::text, 6, '0'), 'change', x.version_id,
       case when x.n % 3 = 0 then array[x.hotel_item, x.flight_item] else array[x.hotel_item] end,
       'Synthetic perf change: check-in moved by one day', 'Synthetic perf reason: customer changed travel dates',
       x.status, 'sales_owner', (select v.version_id from perf3_cv v where v.cr_id = x.id), x.owner_id, x.requested_at, gen_random_uuid(),
       case when x.status not in ('requested') then c.manager end,
       case when x.status not in ('requested') then x.requested_at + interval '1 hour' end,
       case when x.status not in ('requested') then gen_random_uuid() end,
       case when x.status = 'returned' then 'Synthetic perf: say which room type' end,
       case when x.status in ('submitted', 'applied', 'not_possible') then x.owner_id end,
       case when x.status in ('submitted', 'applied', 'not_possible') then x.requested_at + interval '2 hours' end,
       case when x.status = 'applied' then x.requested_at + interval '1 day' end,
       case when x.status in ('not_possible', 'withdrawn') then case x.status when 'withdrawn' then x.owner_id else c.purchase end end,
       case when x.status in ('not_possible', 'withdrawn') then x.requested_at + interval '1 day' end,
       case when x.status in ('not_possible', 'withdrawn') then 'Synthetic perf: the supplier had no room on the new dates' end
from perf3_cr x cross join perf3_ctx c;
-- ASSUMPTION: booking_change_counters (legal_entity_id, year, last_no).
do $$
begin
  if to_regclass('public.booking_change_counters') is not null then
    insert into public.booking_change_counters (legal_entity_id, year, last_no)
    select c.entity_id, 2026, 600000 + pg_temp.n(500) from perf3_ctx c on conflict do nothing;
  end if;
end $$;
-- Reconfirmations: the hotel task of every submitted / applied / not_possible request (and recorded or pending rows), plus,
-- to reach 800, the flight task of each such request (400 requests x 2 tasks). ASSUMPTION: no check refuses a non-Purchase task here (the
-- commands enforce "Purchase tasks only"; perf volume only).
create temporary table perf3_rec on commit drop as
select row_number() over (order by x.n, t.k) as n, x.id as cr_id, x.status as cr_status, x.version_id, t.task_id, gen_random_uuid() as id
from perf3_cr x
cross join lateral (values (1, x.hotel_task), (2, x.flight_task)) t(k, task_id)
where x.status in ('submitted', 'applied', 'not_possible', 'withdrawn', 'approved');
-- A recorded or applied reconfirmation keeps its stored supplier proof (check; one proof per reconfirmation).
create temporary table perf3_recst on commit drop as
select r.*, case r.cr_status when 'applied' then 'applied' when 'not_possible' then case when r.n % 2 = 0 then 'refused' else 'void' end
                             when 'withdrawn' then 'void' when 'approved' then 'pending' else case when r.n % 2 = 0 then 'recorded' else 'pending' end end as rec_status,
       gen_random_uuid() as evidence_id
from perf3_rec r where r.n <= pg_temp.n(800);
insert into public.purchase_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, status, uploaded_by, stored_at)
select r.evidence_id, r.task_id, c.entity_id, 'supplier_confirmation', c.entity_id || '/' || r.task_id || '/' || r.evidence_id,
       'synthetic-reconfirmation-' || r.n || '.pdf', 'application/pdf', 2048, pg_temp.h('perf-reconf-proof-' || r.n), 'stored', c.purchase, now() - interval '6 days'
from perf3_recst r cross join perf3_ctx c where r.rec_status in ('recorded', 'applied');
insert into public.task_reconfirmations (id, legal_entity_id, change_request_id, task_id, booking_version_id, status, new_rate_paise, supplier_fee_paise,
  new_reference, evidence_id, budget_paise, over_budget, over_budget_approved_by, over_budget_approved_at, refused_reason, note, recorded_by, recorded_at,
  request_id)
select r.id, c.entity_id, r.cr_id, r.task_id, r.version_id,
       r.rec_status,
       850000, case when r.n % 4 = 0 then 50000 else 0 end, 'SYN-RECONF-' || r.n,
       case when r.rec_status in ('recorded', 'applied') then r.evidence_id end, 900000, r.n % 10 = 0,
       case when r.n % 10 = 0 and r.cr_status = 'applied' then c.manager end, case when r.n % 10 = 0 and r.cr_status = 'applied' then now() - interval '5 days' end,
       case when r.cr_status = 'not_possible' and r.n % 2 = 0 then 'Synthetic perf: supplier had no room on the new dates' end, null,
       case when r.cr_status not in ('approved', 'submitted') or r.n % 2 = 0 then c.purchase end,
       case when r.cr_status not in ('approved', 'submitted') or r.n % 2 = 0 then now() - interval '6 days' end, gen_random_uuid()
from perf3_recst r cross join perf3_ctx c;
-- booking_version_id is the base version for seeded rows (the seeded change versions are discarded, see above).
-- Confirmation history: confirmation 1 for the hotel tasks of these Deals, confirmation 2 for applied requests (both
-- against cost version 1: the Phase 1 seed has one cost version per hotel task).
insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise, change_fee_paise,
  supplier_reference, evidence_ids, booking_version_id, change_request_id, confirmed_by, confirmed_at)
select c.entity_id, x.hotel_task, 1, q.id, 1, 800000, null, 'SYN-CONF-' || x.n, array[]::uuid[], x.version_id, null, c.purchase, x.requested_at - interval '10 days'
from (select distinct on (hotel_task) * from perf3_cr order by hotel_task, requested_at) x
cross join perf3_ctx c
join lateral (select q.id from public.purchase_quotes q where q.task_id = x.hotel_task order by q.created_at limit 1) q on true
union all
select c.entity_id, x.hotel_task, 2, q.id, 1, 850000, 0, 'SYN-RECONF-CR-' || x.n, array[]::uuid[], x.version_id, x.id, c.purchase, x.requested_at + interval '1 day'
from (select distinct on (hotel_task) * from perf3_cr where status = 'applied' order by hotel_task, requested_at desc) x
cross join perf3_ctx c
join lateral (select q.id from public.purchase_quotes q where q.task_id = x.hotel_task order by q.created_at limit 1) q on true;
analyze public.booking_change_requests, public.task_reconfirmations, public.task_confirmations;

-- ---------------------------------------------------------------------------
-- 4. 3,000 push devices (8.1): at most 10 active per person, the rest removed
-- ---------------------------------------------------------------------------
create temporary table perf3_people on commit drop as
select row_number() over (order by s.work_email) as n, s.user_id from public.staff_profiles s
where s.work_email like 'perf.staff.%@example.test' and s.status = 'active';
insert into public.staff_push_devices (user_id, endpoint, endpoint_hash, p256dh, auth_key, label, status, request_id, created_at, last_used_at,
  removed_at, removed_reason)
select p.user_id, 'https://push.example.test/perf/' || g, pg_temp.h('https://push.example.test/perf/' || g), 'BPerfSyntheticP256dhKey' || lpad(g::text, 6, '0'), 'perfSyntheticAuth' || lpad(g::text, 6, '0'),
       (array['Chrome on Windows', 'Safari on iPhone', 'Edge on Windows', 'Chrome on Android'])[1 + (g % 4)],
       case when (g / (select count(*) from perf3_people)) < 10 then 'active' else 'removed' end, gen_random_uuid(),
       now() - ((g % 90) || ' days')::interval, now() - ((g % 30) || ' days')::interval,
       case when (g / (select count(*) from perf3_people)) >= 10 then now() - ((g % 60) || ' days')::interval end,
       case when (g / (select count(*) from perf3_people)) >= 10 then (array['user', 'signed_out', 'unused_60_days', 'gone'])[1 + (g % 4)] end
from generate_series(0, pg_temp.n(3000) - 1) g
join perf3_people p on p.n = 1 + (g % (select count(*) from perf3_people));
analyze public.staff_push_devices;

-- ---------------------------------------------------------------------------
-- 5. 5,000 write-offs (6.6), one Deal each (Deals 3001..8000)
-- ---------------------------------------------------------------------------
create temporary table perf3_wo on commit drop as
select g as n, gen_random_uuid() as id, d.deal_id, d.branch_id,
       case when g % 10 < 6 then 'approved' when g % 10 = 6 then 'proposed' when g % 10 = 7 then 'returned' when g % 10 = 8 then 'withdrawn'
            else 'undone' end as status,
       case when g % 3 = 0 then 'excess' else 'due' end as direction,
       (100 + (g % 4900) * 100)::bigint as amount,
       now() - ((g % 330) || ' days')::interval as proposed_at
from generate_series(1, pg_temp.n(5000)) g
join perf3_deals d on d.n = 3000 + g;
insert into public.deal_write_offs (id, legal_entity_id, branch_id, deal_id, ref_no, direction, amount_paise, reason, status, proposed_by, proposed_at,
  request_id, decided_by, decided_at, decision_request_id, return_reason, undone_by, undone_at, undo_reason, updated_at)
select w.id, c.entity_id, w.branch_id, w.deal_id, 'WO-2026-' || lpad((500000 + w.n)::text, 6, '0'), w.direction, w.amount,
       'Synthetic perf: small balance after the trip', w.status, c.acc1, w.proposed_at, gen_random_uuid(),
       case when w.status in ('approved', 'returned', 'undone') then c.manager end,
       case when w.status in ('approved', 'returned', 'undone') then w.proposed_at + interval '1 day' end,
       case when w.status in ('approved', 'returned', 'undone') then gen_random_uuid() end,
       case when w.status = 'returned' then 'Synthetic perf: wait for the last receipt' end,
       case when w.status = 'undone' then c.manager2 end, case when w.status = 'undone' then w.proposed_at + interval '3 days' end,
       case when w.status = 'undone' then 'Synthetic perf: customer paid after all' end,
       w.proposed_at + interval '3 days'
from perf3_wo w cross join perf3_ctx c;
-- ASSUMPTION: write_off_counters (legal_entity_id, year, last_no); withdrawn rows need no decided_by.
do $$
begin
  if to_regclass('public.write_off_counters') is not null then
    insert into public.write_off_counters (legal_entity_id, year, last_no)
    select c.entity_id, 2026, 500000 + pg_temp.n(5000) from perf3_ctx c on conflict do nothing;
  end if;
end $$;
analyze public.deal_write_offs;

-- ---------------------------------------------------------------------------
-- 5b. Billing parties for the SYN-PERF Deals (the Tally file needs a mapped customer party ledger;
--     without it every line is left out as party_not_mapped and the file has nothing to export)
-- ---------------------------------------------------------------------------
create temporary table perf3_party on commit drop as
select d.n, d.deal_id, d.branch_id, gen_random_uuid() as party_id from perf3_deals d;
insert into public.customer_parties (id, legal_entity_id, branch_id, party_type, name, phone, city, state_code, postal_code, address_line1,
  source_ref, created_by, updated_by, tally_ledger_name)
select p.party_id, c.entity_id, p.branch_id, 'personal', 'Synthetic Perf Customer ' || lpad(p.n::text, 5, '0'),
       '60000' || lpad((p.n % 100000)::text, 5, '0'), 'Jodhpur', '08', '342001', 'Synthetic street ' || p.n,
       'PERF:C-' || lpad(p.n::text, 5, '0'), c.acc1, c.acc1, 'Synthetic Perf Customer ' || lpad(p.n::text, 5, '0')
from perf3_party p cross join perf3_ctx c;
-- Verified billing on the Deals Accounts reviewed (7 in 10), draft on the rest. Automatic bills are off while seeding
-- (cdoc_auto_on_billing does nothing then).
insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, city, state_code, postal_code, status,
  updated_by, verified_by, verified_at, bill_to_type, phone, party_id, party_copied_at)
select p.deal_id, c.entity_id, 'Synthetic Perf Customer ' || lpad(p.n::text, 5, '0'), 'Synthetic street ' || p.n, 'Jodhpur', '08', '342001',
       case when p.n % 10 < 7 then 'verified' else 'draft' end, c.acc1,
       case when p.n % 10 < 7 then c.acc2 end, case when p.n % 10 < 7 then now() - interval '20 days' end,
       'personal', '60000' || lpad((p.n % 100000)::text, 5, '0'), p.party_id, now() - interval '20 days'
from perf3_party p cross join perf3_ctx c
where not exists (select 1 from public.customer_billing_profiles b where b.deal_id = p.deal_id);
analyze public.customer_parties, public.customer_billing_profiles;

-- ---------------------------------------------------------------------------
-- 6. 20,000 Tally XML lines in 20 XML files of 1,000 lines (7.2, 7.3)
-- ---------------------------------------------------------------------------
-- Files 1-13: journal entries of the Phase 1 seed (13,000 tally_records); files 14-16: 3,000 approved write-offs
-- (new tally_records of kind write_off); files 17-20: 4,000 journal entries "included again" with a reason.
create temporary table perf3_xml on commit drop as
select g as n, gen_random_uuid() as id, now() - ((21 - g) * 7 || ' days')::interval as created_at from generate_series(1, 20) g;
create temporary table perf3_jr on commit drop as
select row_number() over (order by t.id) as rn, t.* from public.tally_records t
where t.record_kind = 'journal_entry' and t.last_export_id is not null;
-- tally_exports rows are append-only: each file's row count is computed before it is written (the lines below fill it).
insert into public.tally_exports (id, legal_entity_id, export_no, period_from, period_to, kinds, include_exported, branch_ids, row_count, created_by,
  request_id, created_at, format, include_reason, company_name)
select x.id, c.entity_id, 'TE-2026-' || lpad((950 + x.n)::text, 6, '0'), (x.created_at - interval '6 days')::date, x.created_at::date,
       case when x.n between 14 and 16 then array['write_off'] else array['journal_entry'] end, x.n >= 17, null,
       greatest(1, case when x.n <= 13 then least(pg_temp.n(1000), greatest(0, (select count(*) from perf3_jr) - (x.n - 1) * pg_temp.n(1000)))
                        when x.n <= 16 then least(pg_temp.n(1000), greatest(0, least((select count(*) from perf3_wo where status = 'approved'), pg_temp.n(3000))
                                                                            - (x.n - 14) * pg_temp.n(1000)))
                        else least(pg_temp.n(1000), greatest(0, (select count(*) from perf3_jr) - (x.n - 17) * pg_temp.n(1000))) end)::integer,
       c.acc1,
       gen_random_uuid(), x.created_at, 'xml',
       case when x.n >= 17 then 'Synthetic perf: the copy company was restored, import the week again' end, 'Synthetic Perf Company'
from perf3_xml x cross join perf3_ctx c;
-- Write-off tally records (approved write-offs are ready for the file; contract 7.2 tally_target).
-- ASSUMPTION: export_count stays 0 for an XML-only record (XML files are tracked apart from CSV exports; LD17).
insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count, xml_export_id, xml_exported_at,
  xml_line_no, row_version)
select c.entity_id, w.branch_id, w.deal_id, 'write_off', w.id, 'exported', 0, x.id, x.created_at, 1 + ((w.rn - 1) % 1000), 1
from (select w.*, row_number() over (order by w.n) as rn from perf3_wo w where w.status = 'approved') w
cross join perf3_ctx c
join perf3_xml x on x.n = 14 + (w.rn - 1) / 1000
where w.rn <= pg_temp.n(3000);
create temporary table perf3_lines on commit drop as
-- Files 1-13: disjoint journal records, 1,000 each.
select x.id as export_id, x.n as file_n, (t.rn - (x.n - 1) * pg_temp.n(1000))::integer as line_no, t.id as tally_record_id, t.record_kind, t.record_id,
       t.legal_entity_id, t.deal_id
from perf3_xml x join perf3_jr t on t.rn between (x.n - 1) * pg_temp.n(1000) + 1 and x.n * pg_temp.n(1000)
where x.n <= 13
union all
-- Files 14-16: the write-off records seeded above.
select x.id, x.n, t.xml_line_no, t.id, t.record_kind, t.record_id, t.legal_entity_id, t.deal_id
from perf3_xml x join public.tally_records t on t.record_kind = 'write_off' and t.xml_export_id = x.id
where x.n between 14 and 16
union all
-- Files 17-20: journal records included again (the first 4,000).
select x.id, x.n, (t.rn - (x.n - 17) * pg_temp.n(1000))::integer, t.id, t.record_kind, t.record_id, t.legal_entity_id, t.deal_id
from perf3_xml x join perf3_jr t on t.rn between (x.n - 17) * pg_temp.n(1000) + 1 and (x.n - 16) * pg_temp.n(1000)
where x.n >= 17;
insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, values, source_hash)
select l.export_id, l.line_no, l.legal_entity_id, l.record_kind, l.record_id, l.tally_record_id,
       jsonb_build_object('date', to_char(now()::date, 'YYYYMMDD'),
         'voucherType', case l.record_kind when 'write_off' then 'Journal' else 'Receipt' end,
         'narration', 'Deal SYN-PERF | SYN-PERF | ' || case l.record_kind when 'write_off' then 'Write-off' else 'Receipt' end || ' perf | TN:TE-2026-'
           || lpad((950 + l.file_n)::text, 6, '0') || '/' || l.line_no,
         'reference', case l.record_kind when 'write_off' then 'WO-perf' else 'R-perf' end,
         'partyLedger', 'Synthetic Perf Customer Ledger', 'amountPaise', '100000', 'recordKind', l.record_kind,
         'entries', jsonb_build_array(jsonb_build_object('ledger', 'Synthetic Bank', 'debitPaise', '100000'),
                                      jsonb_build_object('ledger', 'Synthetic Perf Customer Ledger', 'creditPaise', '100000'))),
       pg_temp.h('xml-' || l.export_id || '-' || l.line_no)
from perf3_lines l;
-- Voucher keys as accounts_tally_file_create writes them (amountPaise is what the matching upload compares).
update public.tally_records t set xml_export_id = l.export_id, xml_exported_at = now() - interval '1 day', xml_line_no = l.line_no,
  row_version = t.row_version + 1
from (select distinct on (tally_record_id) * from perf3_lines where record_kind = 'journal_entry' order by tally_record_id, file_n desc) l
where t.id = l.tally_record_id;
-- Left-out lists: 40 per file (party not mapped, already in a file, kind not in file).
insert into public.tally_export_left_out (export_id, legal_entity_id, record_kind, record_id, reason, detail)
select x.id, (select entity_id from perf3_ctx), 'journal_entry', t.record_id, (array['party_not_mapped', 'already_in_file', 'ledger_not_mapped', 'kind_not_in_file'])[1 + (k % 4)],
       case when k % 4 = 1 then 'TE-2026-' || lpad((950 + greatest(1, x.n - 1))::text, 6, '0') when k % 4 = 2 then 'receipt_bank' end
from perf3_xml x
cross join generate_series(1, 40) k
join lateral (select t.record_id from public.tally_records t where t.record_kind = 'journal_entry' order by md5(t.id::text || x.n::text || k::text) limit 1) t on true
on conflict do nothing;
analyze public.tally_exports, public.tally_records, public.tally_export_lines, public.tally_export_left_out;

-- ---------------------------------------------------------------------------
-- 7. "Bills to check": 500 held and 200 ready automatic Invoice drafts (6.2) on Deals without documents
-- ---------------------------------------------------------------------------
create temporary table perf3_auto on commit drop as
select row_number() over (order by d.n) as n, d.deal_id, d.branch_id, d.reference, d.version_id, d.selling, gen_random_uuid() as id
from perf3_deals d
where not exists (select 1 from public.customer_documents x where x.deal_id = d.deal_id)
  and exists (select 1 from public.accounts_booking_reviews r where r.booking_version_id = d.version_id and r.status = 'approved')
limit pg_temp.n(700);
insert into public.customer_documents (id, legal_entity_id, branch_id, deal_id, kind, status, basis_version_id, content, content_sha256, source_hash,
  total_paise, created_by, created_at, request_id, auto_rule, auto_state, hold_reasons, evaluated_at)
select a.id, c.entity_id, a.branch_id, a.deal_id, 'invoice', 'draft', a.version_id,
       jsonb_build_object('schema', 'cdoc-1', 'kind', 'invoice', 'title', 'Invoice', 'number', null, 'issueDate', null,
         'deal', jsonb_build_object('reference', a.reference, 'dealNumber', null),
         'lines', jsonb_build_array(jsonb_build_object('label', 'Holiday package — Synthetic City', 'amountPaise', a.selling::text)),
         'totalPaise', a.selling::text, 'paidPaise', '0', 'balancePaise', a.selling::text),
       pg_temp.h('auto-' || a.n), pg_temp.h('auto-src-' || a.n), a.selling, null, now() - ((a.n % 72) || ' hours')::interval, gen_random_uuid(),
       'inv_on_approval', case when a.n <= pg_temp.n(500) then 'held' else 'ready' end,
       case when a.n > pg_temp.n(500) then array[]::text[] when a.n % 3 = 0 then array['billing_not_verified']
            when a.n % 3 = 1 then array['newer_version_waiting'] else array['billing_not_verified', 'refund_open'] end,
       now() - ((a.n % 72) || ' hours')::interval
from perf3_auto a cross join perf3_ctx c;
analyze public.customer_documents;

update public.notice_settings set notices_enabled = (select notices_enabled from perf3_switch) where id;

do $$
begin
  raise notice 'accounts3-volume: messages %, events %, contracts %, rate lines %, change requests %, reconfirmations %, push devices % (active %), write-offs %, xml lines %, left out %, auto drafts %',
    (select count(*) from public.customer_messages where provider_message_id like 'SYNPERF-%' or rule in ('perf_seed', 'customer_trip_reminders')),
    (select count(*) from public.customer_message_events where provider_event_id like 'SYNPERF-%'),
    (select count(*) from public.rate_contracts where note = 'SYN-PERF rate contract'),
    (select count(*) from public.rate_contract_lines l join public.rate_contracts r on r.id = l.contract_id where r.note = 'SYN-PERF rate contract'),
    (select count(*) from public.booking_change_requests where ref_no like 'CR-2026-6%'),
    (select count(*) from public.task_reconfirmations where new_reference like 'SYN-RECONF-%'),
    (select count(*) from public.staff_push_devices where endpoint like 'https://push.example.test/perf/%'),
    (select count(*) from public.staff_push_devices where endpoint like 'https://push.example.test/perf/%' and status = 'active'),
    (select count(*) from public.deal_write_offs where ref_no like 'WO-2026-5%'),
    (select count(*) from public.tally_export_lines l join public.tally_exports e on e.id = l.export_id where e.format = 'xml'),
    (select count(*) from public.tally_export_left_out),
    (select count(*) from public.customer_documents where auto_rule = 'inv_on_approval' and status = 'draft');
end $$;
commit;
