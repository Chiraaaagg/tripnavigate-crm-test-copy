-- TripNavigate CRM - Accounts phase 3, track A: customer message reads.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 5.6 (R-A3), 5.10
-- (R-A1, R-A2), 14 (fences; every read returns null when not allowed).
--
--   R-A1 public.deal_customer_messages(deal)       Sales owner, branch Manager, Accounts (authz.cmsg_viewer); never P / F / V.
--                                                   Masked contact only; params (amounts) are never returned.
--   R-A2 public.admin_customer_messages(entity)    Super Admin: switches, pilot, templates, timer state. The template
--                                                   previews and the provider "configured" flags are added by the server
--                                                   (S/modules/customer-messages/server/queries.ts) from the TS list and
--                                                   environment variable names - never values.
--   R-A3 public.task_customer_message_status(task) The task's own department readers: send state words only (LD9).
--
-- Rollback (forward-only): a NEW migration dropping the three reads.

begin;
set local lock_timeout = '15s';

create function authz.cmsg_attachment_kind(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type when 'hotel_voucher' then 'voucher' when 'e_ticket' then 'e_ticket' when 'boarding_pass' then 'boarding_pass' end
$$;

create function public.deal_customer_messages(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_viewer text := authz.cmsg_viewer(p_deal_id);
  v_deal public.deals%rowtype;
  v_prefs public.deal_message_prefs%rowtype;
  c record;
  v_act boolean;
  v_opted boolean;
begin
  if v_viewer is null then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  select * into v_prefs from public.deal_message_prefs p where p.deal_id = v_deal.id;
  select * into c from authz.cmsg_contact(v_deal.id);
  v_act := v_viewer in ('sales', 'manager');
  v_opted := c.mobile is not null and authz.cmsg_opted_out(v_deal.legal_entity_id, c.mobile);
  return jsonb_build_object(
    'dealId', v_deal.id,
    'prefs', jsonb_build_object(
      'language', coalesce(v_prefs.language, 'en'),
      'whatsappMasked', authz.cmsg_mask_mobile(c.mobile),
      'emailMasked', authz.cmsg_mask_email(c.email),
      'whatsappOff', coalesce(v_prefs.whatsapp_off, false),
      'emailOff', coalesce(v_prefs.email_off, false),
      'optedOut', v_opted,
      'rowVersion', coalesce(v_prefs.row_version, 0)),
    'contactConfirmed', coalesce(c.confirmed, false),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', m.id, 'type', m.message_type, 'channel', m.channel, 'language', m.language, 'status', m.status,
          'skipReason', m.skip_reason, 'createdAt', m.created_at, 'sentAt', m.sent_at, 'deliveredAt', m.delivered_at,
          'readAt', m.read_at, 'failedAt', m.failed_at, 'errorCode', m.last_error_code, 'toMasked', m.to_masked,
          'attachmentKind', case when m.attachment is not null then authz.cmsg_attachment_kind(m.message_type) end,
          'resendOf', m.resend_of,
          'can', jsonb_build_object('resend', v_act and m.status in ('failed', 'skipped', 'stopped')
                                     and authz.cmsg_can_resend(m)
                                     and authz.cmsg_switch_on(m.legal_entity_id, m.message_type, m.channel)))
        order by m.created_at desc, m.id desc)
      from public.customer_messages m
      where m.id in (select x.id from public.customer_messages x where x.deal_id = v_deal.id
                     order by x.created_at desc, x.id desc limit 100)), '[]'::jsonb),
    'can', jsonb_build_object('editPrefs', v_act, 'restartWhatsapp', v_act and v_opted));
end;
$$;

create function authz.timer_vault_configured() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean;
begin
  if to_regclass('vault.secrets') is null then
    return false;
  end if;
  execute $q$select count(distinct s.name) = 2 from vault.secrets s where s.name in ('crm_timer_url', 'crm_timer_bearer')$q$ into v;
  return coalesce(v, false);
end;
$$;

create function public.admin_customer_messages(p_entity uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_timer public.timer_settings%rowtype;
begin
  if p_entity is null or not coalesce(authz.can_switch_live_settings(p_entity), false) then
    return null;
  end if;
  select * into v_timer from public.timer_settings s where s.id;
  return jsonb_build_object(
    'entityId', p_entity,
    'switches', coalesce((select jsonb_agg(jsonb_build_object('type', s.message_type, 'channel', s.channel, 'enabled', s.enabled,
                                    'rowVersion', s.row_version, 'updatedAt', s.updated_at)
                                  order by array_position(authz.cmsg_types(), s.message_type), s.channel)
                          from public.customer_message_switches s where s.legal_entity_id = p_entity), '[]'::jsonb),
    'pilotOnly', coalesce((select s.pilot_only from public.customer_message_settings s where s.legal_entity_id = p_entity), true),
    'pilot', coalesce((select jsonb_agg(jsonb_build_object('dealId', p.deal_id, 'dealReference', d.reference, 'addedAt', p.added_at)
                               order by p.added_at desc)
                       from public.customer_message_pilot p join public.deals d on d.id = p.deal_id
                       where p.legal_entity_id = p_entity and p.removed_at is null), '[]'::jsonb),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('templateCode', t.template_code, 'status', t.status,
                                    'rowVersion', t.row_version, 'updatedAt', t.updated_at) order by t.template_code)
                           from public.whatsapp_templates t where t.legal_entity_id = p_entity), '[]'::jsonb),
    -- Filled by the server from environment variable names (never values); null here = unknown.
    'providers', jsonb_build_array(
      jsonb_build_object('key', 'RESEND_API_KEY', 'configured', null),
      jsonb_build_object('key', 'RESEND_WEBHOOK_SECRET', 'configured', null),
      jsonb_build_object('key', 'INTERAKT_API_KEY', 'configured', null),
      jsonb_build_object('key', 'INTERAKT_WEBHOOK_SECRET', 'configured', null),
      jsonb_build_object('key', 'TIMER_SECRET', 'configured', null)),
    'timer', jsonb_build_object(
      'enabled', coalesce(v_timer.enabled, false),
      -- Vault names present (values never read here).
      'configured', authz.timer_vault_configured(),
      'lastOkAt', v_timer.last_ok_at,
      'queueOldestMinutes', (select floor(extract(epoch from now() - min(greatest(m.next_attempt_at, m.not_before))) / 60)::integer
                             from public.customer_messages m
                             where m.status = 'queued' and m.next_attempt_at <= now() and m.not_before <= now()
                               and m.legal_entity_id = p_entity)),
    'counts', jsonb_build_object(
      'failedLast24h', (select count(*) from public.customer_messages m
                        where m.legal_entity_id = p_entity and m.status = 'failed' and m.failed_at >= now() - interval '24 hours'),
      'enqueueFailuresLast24h', (select count(*) from public.customer_message_enqueue_failures f
                                 where f.failed_at >= now() - interval '24 hours')));
end;
$$;

-- LD9 states: not_sent | waiting | sent | failed | off.
create function authz.cmsg_send_state(p_deal uuid, p_entity uuid, p_type text, p_channel text, p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when m.status in ('queued', 'sending') then 'waiting'
      when m.status in ('sent', 'delivered', 'read') then 'sent'
      when m.status = 'failed' then 'failed'
      when m.skip_reason in ('channel_off_on_deal', 'opted_out', 'template_not_approved', 'test_deal', 'not_in_pilot', 'switched_off') then 'off'
      else 'not_sent' end
    from public.customer_messages m
    where m.deal_id = p_deal and m.message_type = p_type and m.channel = p_channel
      and (m.event_key = p_key or m.event_key like p_key || ':r%')
    order by m.created_at desc, m.id desc limit 1),
    case when authz.cmsg_switch_on(p_entity, p_type, p_channel) then 'not_sent' else 'off' end)
$$;

create function public.task_customer_message_status(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  if p_task_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department not in ('purchase', 'flight')
     or not authz.holds_active_role(v_task.department, v_task.legal_entity_id) then
    return null;
  end if;
  return jsonb_build_object(
    'taskId', v_task.id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
          'evidenceId', f.id, 'messageType', f.message_type,
          'email', jsonb_build_object('state', authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, f.message_type, 'email', f.event_key)),
          'whatsapp', jsonb_build_object('state', authz.cmsg_send_state(v_task.deal_id, v_task.legal_entity_id, f.message_type, 'whatsapp', f.event_key)))
        order by f.stored_at, f.id)
      from (
        select e.id, 'hotel_voucher'::text as message_type, 'voucher:' || e.id::text as event_key, e.stored_at
        from public.purchase_evidence e
        where v_task.department = 'purchase' and e.task_id = v_task.id and e.kind = 'customer_voucher' and e.status = 'stored'
        union all
        select e.id, e.kind, case e.kind when 'e_ticket' then 'eticket:' else 'bp:' end || e.id::text, e.stored_at
        from public.department_evidence e
        where v_task.department = 'flight' and e.task_id = v_task.id and e.kind in ('e_ticket', 'boarding_pass') and e.status = 'stored'
      ) f), '[]'::jsonb));
end;
$$;

revoke all on function
  authz.cmsg_attachment_kind(text), authz.timer_vault_configured(), authz.cmsg_send_state(uuid, uuid, text, text, text),
  public.deal_customer_messages(uuid), public.admin_customer_messages(uuid), public.task_customer_message_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.deal_customer_messages(uuid), public.admin_customer_messages(uuid), public.task_customer_message_status(uuid)
to authenticated;

commit;
