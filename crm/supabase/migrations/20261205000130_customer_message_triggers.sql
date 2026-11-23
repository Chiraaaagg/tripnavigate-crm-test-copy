-- TripNavigate CRM - Accounts phase 3, track A: the events that queue customer
-- messages, and the two message timer tasks.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 5.5, 5.6, LD8, 17.1.
--
-- AFTER triggers (each guarded: a failure is counted, never raised; each
-- returns at once while no switch of its type is On; no lock beyond the rows
-- they insert):
--   accounts_booking_reviews  booking_confirmed  first last_approved_at of the Deal (LD8), event 'deal'
--   customer_receipts         payment_received   verified (non-cheque) / cleared (cheque), 'receipt:<id>'
--                                                (balance after the posting)
--   department_evidence       e_ticket           stored e_ticket of a Flight task with a ticket batch, 'eticket:<id>'
--                             boarding_pass      stored boarding_pass, 'bp:<id>'
--   flight_ticket_batches     e_ticket           the batch makes earlier stored e-tickets sendable
--   visa_result_notices       visa_status        'visa:<application>:<approved|not_approved>'
--   customer_refund_payouts   refund_paid        'payout:<id>'
-- hotel_voucher is queued by purchase_voucher_mark_ready (0120); booking_changed
-- by tracks G and H through authz.cmsg_enqueue.
-- Timer tasks: customer_trip_reminders (15 min, from 10:00 India time, D-3 and
-- D-1) and flight_boarding_pass_due (15 min).
--
-- Rollback (forward-only): a NEW migration dropping the triggers and tasks
-- (disable the tasks: timer_tasks rows are never deleted).

begin;
set local lock_timeout = '15s';

create index booking_versions_confirmed_trip_start_idx on public.booking_versions (trip_start) where status = 'confirmed';
create index flight_sectors_active_depart_idx on public.flight_sectors (depart_date) where status = 'active';

-- ===========================================================================
-- 1. Triggers
-- ===========================================================================

create function authz.cmsg_on_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.last_approved_at is null or (tg_op = 'UPDATE' and old.last_approved_at is not null)
     or not authz.cmsg_type_on(new.legal_entity_id, 'booking_confirmed') then
    return null;
  end if;
  begin
    -- LD8: once per Deal, at the first Accounts approval only.
    if not exists (select 1 from public.accounts_booking_reviews r
                   where r.deal_id = new.deal_id and r.id <> new.id and r.last_approved_at is not null) then
      perform authz.cmsg_enqueue(new.deal_id, 'booking_confirmed', 'deal', '{}'::jsonb, null);
    end if;
  exception when others then
    perform authz.cmsg_note_failure('booking_confirmed', sqlstate);
  end;
  return null;
end;
$$;
create trigger accounts_booking_reviews_cmsg after insert or update of last_approved_at on public.accounts_booking_reviews
  for each row execute function authz.cmsg_on_review();

-- Balance of the Deal (dues) after this receipt is posted, never below 0, as a
-- decimal string of paise. The status changes before the journal posting in
-- receipt_verify / cheque_clear, so an unposted receipt is subtracted here.
create function authz.cmsg_balance_after(p_deal uuid, p_receipt uuid, p_amount bigint) returns text
language sql stable security definer set search_path = '' as $$
  select greatest(coalesce((
    select c.balance from public.deals d
    cross join lateral authz.dues_compute(array[d.legal_entity_id], array[]::uuid[], array[]::uuid[], d.is_synthetic, d.id, true) c
    where d.id = p_deal limit 1), 0)
    - case when exists (select 1 from public.finance_journal_entries e
                        where e.receipt_id = p_receipt and e.kind in ('receipt_bank', 'receipt_cash')) then 0 else p_amount end, 0)::text
$$;

create function authz.cmsg_on_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.cmsg_type_on(new.legal_entity_id, 'payment_received') then
    return null;
  end if;
  begin
    perform authz.cmsg_enqueue(new.deal_id, 'payment_received', 'receipt:' || new.id::text,
      jsonb_build_object('amountPaise', new.amount_paise::text,
                         'balancePaise', authz.cmsg_balance_after(new.deal_id, new.id, new.amount_paise)), null);
  exception when others then
    perform authz.cmsg_note_failure('payment_received', sqlstate);
  end;
  return null;
end;
$$;
create trigger customer_receipts_cmsg after update of status on public.customer_receipts
  for each row
  when ((new.status = 'verified' and new.mode <> 'cheque' and old.status is distinct from 'verified')
        or (new.status = 'cleared' and new.mode = 'cheque' and old.status is distinct from 'cleared'))
  execute function authz.cmsg_on_receipt();

create function authz.cmsg_on_department_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_type text := case new.kind when 'e_ticket' then 'e_ticket' when 'boarding_pass' then 'boarding_pass' end;
begin
  if v_type is null or new.status <> 'stored' or (tg_op = 'UPDATE' and old.status = 'stored')
     or not authz.cmsg_type_on(new.legal_entity_id, v_type) then
    return null;
  end if;
  begin
    select * into v_task from public.fulfilment_tasks t where t.id = new.task_id;
    if v_task.department = 'flight' and authz.flight_task_has_batch(v_task.id) then
      perform authz.cmsg_enqueue(v_task.deal_id, v_type,
        case v_type when 'e_ticket' then 'eticket:' else 'bp:' end || new.id::text, '{}'::jsonb,
        jsonb_build_object('source', 'department_evidence', 'id', new.id));
    end if;
  exception when others then
    perform authz.cmsg_note_failure(v_type, sqlstate);
  end;
  return null;
end;
$$;
create trigger department_evidence_cmsg after insert or update of status on public.department_evidence
  for each row execute function authz.cmsg_on_department_evidence();

create function authz.cmsg_on_ticket_batch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if not authz.cmsg_type_on(new.legal_entity_id, 'e_ticket') then
    return null;
  end if;
  begin
    for r in
      select e.id, t.deal_id from public.department_evidence e
      join public.fulfilment_tasks t on t.id = e.task_id
      where e.kind = 'e_ticket' and e.status = 'stored' and t.department = 'flight'
        and (t.id = new.cost_task_id
             or t.id in (select s.task_id from public.flight_sectors s where s.id = any (new.sector_ids)))
    loop
      perform authz.cmsg_enqueue(r.deal_id, 'e_ticket', 'eticket:' || r.id::text, '{}'::jsonb,
        jsonb_build_object('source', 'department_evidence', 'id', r.id));
    end loop;
  exception when others then
    perform authz.cmsg_note_failure('e_ticket', sqlstate);
  end;
  return null;
end;
$$;
create trigger flight_ticket_batches_cmsg after insert on public.flight_ticket_batches
  for each row execute function authz.cmsg_on_ticket_batch();

create function authz.cmsg_on_visa_result() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_outcome text := case new.outcome when 'approved' then 'approved' else 'not_approved' end;
  v_name text;
begin
  if not authz.cmsg_type_on(new.legal_entity_id, 'visa_status') then
    return null;
  end if;
  begin
    select coalesce(
      (select t.full_name from public.booking_versions v
       join public.booking_version_travellers t on t.booking_version_id = v.id and t.seq = new.traveller_seq
       where v.deal_id = new.deal_id and v.status = 'confirmed' limit 1),
      (select t.full_name from public.deal_travellers t where t.deal_id = new.deal_id and t.seq = new.traveller_seq))
      into v_name;
    perform authz.cmsg_enqueue(new.deal_id, 'visa_status', 'visa:' || new.application_id::text || ':' || v_outcome,
      jsonb_strip_nulls(jsonb_build_object('travellerName', v_name, 'outcome', v_outcome)), null);
  exception when others then
    perform authz.cmsg_note_failure('visa_status', sqlstate);
  end;
  return null;
end;
$$;
create trigger visa_result_notices_cmsg after insert on public.visa_result_notices
  for each row execute function authz.cmsg_on_visa_result();

create function authz.cmsg_on_refund_payout() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.cmsg_type_on(new.legal_entity_id, 'refund_paid') then
    return null;
  end if;
  begin
    perform authz.cmsg_enqueue(new.deal_id, 'refund_paid', 'payout:' || new.id::text,
      jsonb_build_object('amountPaise', new.amount_paise::text), null);
  exception when others then
    perform authz.cmsg_note_failure('refund_paid', sqlstate);
  end;
  return null;
end;
$$;
create trigger customer_refund_payouts_cmsg after insert on public.customer_refund_payouts
  for each row execute function authz.cmsg_on_refund_payout();

-- ===========================================================================
-- 2. Timer tasks
-- ===========================================================================

-- Trip reminders 3 days and 1 day before the trip starts (India time), from 10:00.
create function authz.customer_trip_reminders() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_today date := authz.finance_today();
  r record;
  v_queued integer := 0;
begin
  if (now() at time zone 'Asia/Kolkata')::time < time '10:00' then
    return jsonb_build_object('beforeTen', 1, 'rows', 0);
  end if;
  for r in
    select v.deal_id, v.trip_start, (v.trip_start - v_today) as days_left, d.legal_entity_id
    from public.booking_versions v
    join public.deals d on d.id = v.deal_id
    where v.status = 'confirmed' and v.trip_start in (v_today + 1, v_today + 3)
      and (select count(*) from public.customer_message_switches s
           where s.legal_entity_id = d.legal_entity_id and s.message_type = 'trip_reminder' and s.enabled)
          > (select count(*) from public.customer_messages m
             where m.deal_id = v.deal_id and m.message_type = 'trip_reminder'
               and m.event_key = case when v.trip_start = v_today + 3 then 'd3:' else 'd1:' end || v.trip_start::text)
  loop
    v_queued := v_queued + authz.cmsg_enqueue(r.deal_id, 'trip_reminder',
      case when r.days_left = 3 then 'd3:' else 'd1:' end || r.trip_start::text,
      jsonb_build_object('daysLeft', r.days_left::text), null);
  end loop;
  return jsonb_build_object('beforeTen', 0, 'rows', v_queued);
end;
$$;

-- Boarding pass due: an active sector departing within 24 hours whose Flight
-- task has no boarding pass stored after its latest ticket batch.
create function authz.flight_boarding_pass_due() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
  v_today date := authz.finance_today();
begin
  insert into public.flight_boarding_pass_alerts (legal_entity_id, branch_id, deal_id, task_id, sector_id, departure_date)
  select s.legal_entity_id, s.branch_id, s.deal_id, s.task_id, s.id, s.depart_date
  from public.flight_sectors s
  join public.fulfilment_tasks t on t.id = s.task_id and t.department = 'flight'
  cross join lateral (
    select max(b.confirmed_at) as last_batch from public.flight_ticket_batches b
    where b.cost_task_id = t.id
       or exists (select 1 from public.flight_sectors s2 where s2.task_id = t.id and s2.id = any (b.sector_ids))) lb
  where s.status = 'active'
    and s.depart_date between v_today and v_today + 1
    and ((s.depart_date + coalesce(s.depart_time, '00:00')::time) at time zone 'Asia/Kolkata')
        between now() - interval '1 hour' and now() + interval '24 hours'
    and lb.last_batch is not null
    and not authz.deal_trip_cancelled(s.deal_id)
    and not exists (select 1 from public.department_evidence e
                    where e.task_id = t.id and e.kind = 'boarding_pass' and e.status = 'stored' and e.stored_at > lb.last_batch)
  on conflict (task_id, sector_id, departure_date) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('alerts', v_n);
end;
$$;

select authz.timer_task_register('customer_trip_reminders', 'authz.customer_trip_reminders', 15);
select authz.timer_task_register('flight_boarding_pass_due', 'authz.flight_boarding_pass_due', 15);

revoke all on function
  authz.cmsg_on_review(), authz.cmsg_balance_after(uuid, uuid, bigint), authz.cmsg_on_receipt(), authz.cmsg_on_department_evidence(),
  authz.cmsg_on_ticket_batch(), authz.cmsg_on_visa_result(), authz.cmsg_on_refund_payout(),
  authz.customer_trip_reminders(), authz.flight_boarding_pass_due()
from public, anon, authenticated, service_role;

commit;
