-- TripNavigate CRM - Accounts phase 3, track A: boarding pass per passenger
-- and flight (contract 15 item 3, "upload per passenger and flight"; lead
-- request 13 Nov 2026). Additive only.
--
-- 1. boarding_pass_slot_files: links a stored boarding_pass file of a Flight
--    task to one active sector and one traveller of that task (optional; a
--    file without a link still counts and is still sent).
-- 2. public.boarding_pass_slot_link(evidence, sector, traveller_seq): the
--    file's uploader (the Flight task's assignee) links it once, right after
--    the upload. Refusals not_authorized (42501), invalid_input (22023, hint
--    sectorId | passengerSeq), already_recorded -> outcome existing.
-- 3. public.task_customer_files (replaces 20261205000160, same signature):
--    additive keys - Flight tasks get `slots` [{sectorId, sectorLabel
--    ("DEL–BOM 14 Nov"), passengerSeq, passengerName, evidenceId, email,
--    whatsapp}] (active sectors x the task's travellers) and every file gets
--    `sectorId`, `passengerSeq` (null when not linked). Flight already reads
--    its own task's travellers; no phone, e-mail, PNR or ticket number.
--
-- Rollback (forward-only): a NEW migration restoring the 20261205000160 body
-- of task_customer_files and dropping the table and the command.

begin;
set local lock_timeout = '15s';

create table public.boarding_pass_slot_files (
  evidence_id uuid primary key references public.department_evidence (id),
  legal_entity_id uuid not null,
  task_id uuid not null,
  sector_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  linked_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, sector_id) references public.flight_sectors (task_id, id)
);
create index boarding_pass_slot_files_task_idx on public.boarding_pass_slot_files (legal_entity_id, task_id);
create index boarding_pass_slot_files_sector_idx on public.boarding_pass_slot_files (task_id, sector_id, traveller_seq);
create index boarding_pass_slot_files_linked_by_idx on public.boarding_pass_slot_files (linked_by);
create trigger boarding_pass_slot_files_a_guard before update or delete on public.boarding_pass_slot_files
  for each row execute function authz.cmsg_append_only_guard();
alter table public.boarding_pass_slot_files enable row level security;
create policy require_valid_session on public.boarding_pass_slot_files as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.boarding_pass_slot_files from public, anon, authenticated, service_role;

-- The travellers of a Flight task (its service item on the Deal's confirmed version) with their names.
create function authz.flight_task_travellers(p_task uuid) returns table (seq integer, full_name text)
language sql stable security definer set search_path = '' as $$
  with t as (
    select ft.id, ft.deal_id, ft.service_item_id,
           coalesce((select v.id from public.booking_versions v where v.deal_id = ft.deal_id and v.status = 'confirmed' limit 1),
                    ft.booking_version_id) as version_id
    from public.fulfilment_tasks ft where ft.id = p_task
  )
  select st.traveller_seq,
         coalesce(bt.full_name, dt.full_name, 'Traveller ' || st.traveller_seq::text)
  from t
  join public.service_item_travellers st on st.service_item_id = t.service_item_id and st.booking_version_id = t.version_id
  left join public.booking_version_travellers bt on bt.booking_version_id = t.version_id and bt.seq = st.traveller_seq
  left join public.deal_travellers dt on dt.deal_id = t.deal_id and dt.seq = st.traveller_seq
  order by st.traveller_seq
$$;

create function public.boarding_pass_slot_link(p_evidence_id uuid, p_sector_id uuid, p_traveller_seq integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.department_evidence%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_existing public.boarding_pass_slot_files%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.department_evidence e where e.id = p_evidence_id) for update;
  select * into v_ev from public.department_evidence e where e.id = p_evidence_id;
  if v_ev.id is null or v_task.id is null or v_ev.kind <> 'boarding_pass' or v_ev.uploaded_by is distinct from (select auth.uid())
     or not authz.flight_can_upload_boarding_pass(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_existing from public.boarding_pass_slot_files s where s.evidence_id = v_ev.id;
  if v_existing.evidence_id is not null then
    if v_existing.sector_id = p_sector_id and v_existing.traveller_seq = p_traveller_seq then
      return jsonb_build_object('outcome', 'existing', 'evidenceId', v_ev.id);
    end if;
    raise exception 'already_recorded' using errcode = '55000';
  end if;
  if p_sector_id is null or not exists (select 1 from public.flight_sectors s
                                        where s.id = p_sector_id and s.task_id = v_task.id and s.status = 'active') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sectorId';
  end if;
  if p_traveller_seq is null or not exists (select 1 from authz.flight_task_travellers(v_task.id) x where x.seq = p_traveller_seq) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'passengerSeq';
  end if;
  insert into public.boarding_pass_slot_files (evidence_id, legal_entity_id, task_id, sector_id, traveller_seq, linked_by)
  values (v_ev.id, v_task.legal_entity_id, v_task.id, p_sector_id, p_traveller_seq, (select auth.uid()));
  return jsonb_build_object('outcome', 'created', 'evidenceId', v_ev.id);
end;
$$;

create or replace function public.task_customer_files(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_kind text;
  v_type text;
  v_can_upload boolean;
  v_today date := authz.finance_today();
begin
  if p_task_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department not in ('purchase', 'flight')
     or not authz.holds_active_role(v_task.department, v_task.legal_entity_id) then
    return null;
  end if;
  if v_task.department = 'purchase' then
    v_kind := 'customer_voucher';
    v_type := 'hotel_voucher';
    v_can_upload := v_task.status = 'supplier_confirmed' and authz.can_work_purchase_task(v_task.id);
  else
    v_kind := 'boarding_pass';
    v_type := 'boarding_pass';
    v_can_upload := authz.flight_can_upload_boarding_pass(v_task.id) and authz.flight_task_has_batch(v_task.id);
  end if;
  return jsonb_build_object(
    'taskId', v_task.id,
    'kind', v_kind,
    'taskConfirmed', case when v_task.department = 'purchase' then v_task.status = 'supplier_confirmed'
                          else authz.flight_task_has_batch(v_task.id) end,
    'can', jsonb_build_object('upload', v_can_upload,
                              'markReady', v_task.department = 'purchase' and v_can_upload),
    'due', v_task.department = 'flight' and exists (
      select 1 from public.flight_boarding_pass_alerts a
      where a.task_id = v_task.id and a.departure_date >= v_today
        and not exists (select 1 from public.department_evidence e
                        where e.task_id = v_task.id and e.kind = 'boarding_pass' and e.status = 'stored' and e.stored_at > a.created_at)),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
          'evidenceId', f.id, 'fileName', f.file_name, 'status', f.status, 'storedAt', f.stored_at, 'readyAt', f.ready_at,
          -- Accounts phase 3 (20261205000170): the passenger and flight the file belongs to (null = not linked).
          'sectorId', f.sector_id, 'passengerSeq', f.traveller_seq,
          'email', jsonb_build_object('state', case when f.status = 'stored' and (v_kind = 'boarding_pass' or f.ready_at is not null)
            then authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, v_type, 'email', f.event_key) else 'not_sent' end),
          'whatsapp', jsonb_build_object('state', case when f.status = 'stored' and (v_kind = 'boarding_pass' or f.ready_at is not null)
            then authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, v_type, 'whatsapp', f.event_key) else 'not_sent' end))
        order by f.created_at, f.id)
      from (
        select e.id, e.file_name, e.status, e.stored_at, e.customer_ready_at as ready_at, e.created_at, 'voucher:' || e.id::text as event_key,
               null::uuid as sector_id, null::integer as traveller_seq
        from public.purchase_evidence e
        where v_kind = 'customer_voucher' and e.task_id = v_task.id and e.kind = 'customer_voucher' and e.status in ('pending_upload', 'stored', 'failed')
        union all
        select e.id, e.file_name, e.status, e.stored_at, null::timestamptz, e.created_at, 'bp:' || e.id::text, s.sector_id, s.traveller_seq
        from public.department_evidence e
        left join public.boarding_pass_slot_files s on s.evidence_id = e.id
        where v_kind = 'boarding_pass' and e.task_id = v_task.id and e.kind = 'boarding_pass' and e.status in ('pending_upload', 'stored', 'failed')
      ) f), '[]'::jsonb),
    -- Accounts phase 3 (20261205000170): one boarding-pass slot per active flight and traveller of the task.
    'slots', case when v_task.department <> 'flight' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
          'sectorId', z.sector_id, 'sectorLabel', z.label, 'passengerSeq', z.seq, 'passengerName', z.full_name,
          'evidenceId', z.evidence_id,
          'email', jsonb_build_object('state', case when z.evidence_id is null then 'not_sent'
            else authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, 'boarding_pass', 'email', 'bp:' || z.evidence_id::text) end),
          'whatsapp', jsonb_build_object('state', case when z.evidence_id is null then 'not_sent'
            else authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, 'boarding_pass', 'whatsapp', 'bp:' || z.evidence_id::text) end))
        order by z.depart_date, z.depart_time nulls last, z.sector_id, z.seq)
      from (
        select s.id as sector_id, s.depart_date, s.depart_time, x.seq, x.full_name,
               left(s.from_place || '–' || s.to_place || ' ' || to_char(s.depart_date, 'DD Mon'), 80) as label,
               (select l.evidence_id from public.boarding_pass_slot_files l
                join public.department_evidence e on e.id = l.evidence_id and e.status = 'stored'
                where l.task_id = v_task.id and l.sector_id = s.id and l.traveller_seq = x.seq
                order by e.stored_at desc limit 1) as evidence_id
        from public.flight_sectors s
        cross join authz.flight_task_travellers(v_task.id) x
        where s.task_id = v_task.id and s.status = 'active'
      ) z), '[]'::jsonb) end);
end;
$$;

revoke all on function authz.flight_task_travellers(uuid), public.boarding_pass_slot_link(uuid, uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function public.boarding_pass_slot_link(uuid, uuid, integer) to authenticated;

commit;
