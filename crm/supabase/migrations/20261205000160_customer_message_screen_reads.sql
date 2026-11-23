-- TripNavigate CRM - Accounts phase 3, track A: small reads the screens need
-- (lead request to track A, 13 Nov 2026; contract 15 items 1, 3, 4).
--
--   public.deal_message_prefs_get(deal)            Book now / Deal: language and WhatsApp choice with the row version;
--                                                   the same callers as deal_message_prefs_set; masks only.
--   public.customer_message_deal_lookup(entity, reference)
--                                                   Settings > Customer messages: a Deal of the entity by its exact
--                                                   reference (never by customer name), Super Admin only.
--   public.task_customer_files(task)               Purchase task > Customer voucher, Flight task > Boarding pass:
--                                                   the task's own files of that kind, the LD9 send states, what the
--                                                   caller can do and the "due" flag. The task's department readers only.
-- Every read returns null when not allowed (contract 14).
--
-- Rollback (forward-only): a NEW migration dropping the three reads.

begin;
set local lock_timeout = '15s';

create function public.deal_message_prefs_get(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_prefs public.deal_message_prefs%rowtype;
begin
  if p_deal_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null
     or not (authz.cmsg_can_act(v_deal.id)
             or (not exists (select 1 from public.booking_versions v where v.deal_id = v_deal.id and v.status in ('confirmed', 'superseded'))
                 and coalesce(authz.can_edit_booking_draft(v_deal.id), false))) then
    return null;
  end if;
  select * into v_prefs from public.deal_message_prefs p where p.deal_id = v_deal.id;
  return jsonb_build_object(
    'dealId', v_deal.id,
    'language', coalesce(v_prefs.language, 'en'),
    'whatsappSameAsMobile', v_prefs.whatsapp_mobile is null,
    'whatsappMasked', authz.cmsg_mask_mobile(v_prefs.whatsapp_mobile),
    'emailOverrideMasked', authz.cmsg_mask_email(v_prefs.email_override),
    'whatsappOff', coalesce(v_prefs.whatsapp_off, false),
    'emailOff', coalesce(v_prefs.email_off, false),
    'rowVersion', coalesce(v_prefs.row_version, 0));
end;
$$;

create function public.customer_message_deal_lookup(p_entity uuid, p_reference text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ref text := btrim(coalesce(p_reference, ''));
begin
  if p_entity is null or not coalesce(authz.can_switch_live_settings(p_entity), false)
     or length(v_ref) not between 1 and 60 then
    return null;
  end if;
  return (
    select jsonb_build_object('dealId', d.id, 'dealReference', d.reference, 'branchName', b.name,
      'inPilot', exists (select 1 from public.customer_message_pilot p where p.deal_id = d.id and p.removed_at is null))
    from public.deals d join public.branches b on b.id = d.branch_id
    where d.legal_entity_id = p_entity and upper(d.reference) = upper(v_ref)
    limit 1);
end;
$$;

create function public.task_customer_files(p_task_id uuid) returns jsonb
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
    -- Flight: an active sector departs within 24 hours and no boarding pass is stored after the latest ticket batch.
    'due', v_task.department = 'flight' and exists (
      select 1 from public.flight_boarding_pass_alerts a
      where a.task_id = v_task.id and a.departure_date >= v_today
        and not exists (select 1 from public.department_evidence e
                        where e.task_id = v_task.id and e.kind = 'boarding_pass' and e.status = 'stored' and e.stored_at > a.created_at)),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
          'evidenceId', f.id, 'fileName', f.file_name, 'status', f.status, 'storedAt', f.stored_at, 'readyAt', f.ready_at,
          'email', jsonb_build_object('state', case when f.status = 'stored' and (v_kind = 'boarding_pass' or f.ready_at is not null)
            then authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, v_type, 'email', f.event_key) else 'not_sent' end),
          'whatsapp', jsonb_build_object('state', case when f.status = 'stored' and (v_kind = 'boarding_pass' or f.ready_at is not null)
            then authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, v_type, 'whatsapp', f.event_key) else 'not_sent' end))
        order by f.created_at, f.id)
      from (
        select e.id, e.file_name, e.status, e.stored_at, e.customer_ready_at as ready_at, e.created_at, 'voucher:' || e.id::text as event_key
        from public.purchase_evidence e
        where v_kind = 'customer_voucher' and e.task_id = v_task.id and e.kind = 'customer_voucher' and e.status in ('pending_upload', 'stored', 'failed')
        union all
        select e.id, e.file_name, e.status, e.stored_at, null::timestamptz, e.created_at, 'bp:' || e.id::text
        from public.department_evidence e
        where v_kind = 'boarding_pass' and e.task_id = v_task.id and e.kind = 'boarding_pass' and e.status in ('pending_upload', 'stored', 'failed')
      ) f), '[]'::jsonb));
end;
$$;

revoke all on function
  public.deal_message_prefs_get(uuid), public.customer_message_deal_lookup(uuid, text), public.task_customer_files(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.deal_message_prefs_get(uuid), public.customer_message_deal_lookup(uuid, text), public.task_customer_files(uuid)
to authenticated;

commit;
