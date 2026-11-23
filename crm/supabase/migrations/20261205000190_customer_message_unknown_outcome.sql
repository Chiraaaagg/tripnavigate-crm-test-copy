-- TripNavigate CRM - Accounts phase 3, track A fix-forward (independent
-- backend review, 13 Nov 2026; contract addendum to be recorded by the lead).
--
-- 1. No duplicate customer message after an unclear send:
--    * customer_messages.status gains 'unknown' and last_error_code gains
--      'unknown_outcome': the request left and no answer came back (timeout,
--      connection reset). It is never retried automatically; it raises the
--      message_failed alert (track D notice 43) and audit messages.failed
--      {errorCode: unknown_outcome}; the Sales owner or branch Manager may
--      "Send again" after checking (authz.cmsg_can_resend).
--    * customer_message_complete: any 2xx answer is sent (p_ok true; the
--      provider id is stored when present, may be null); p_error_code
--      'unknown_outcome' -> unknown. Only failures before the request left
--      ('network': DNS, connection refused) and provider errors stay retryable.
--    * customer_message_event_record: a sent / delivered / read report for a
--      queued (retry waiting), sending or unknown row marks it sent and clears
--      the retry and the error.
-- 2. "Send again" locks the root (original) message of the chain FOR UPDATE
--    before the check (two presses can no longer both pass).
-- 3. Retries of a quiet type: next_attempt_at = authz.cmsg_not_before(type,
--    now() + delay) (LD5 also for retries).
-- R-A1 can.resend and the LD9 send state ('failed') include 'unknown'.
--
-- Replaced (latest bodies, same signatures): authz.customer_messages_guard
-- (0110), public.customer_message_event_record (0120),
-- public.customer_message_complete (0120), public.customer_message_resend
-- (0120), authz.cmsg_can_resend (0150), public.deal_customer_messages (0180),
-- authz.cmsg_send_state (0140). New: authz.cmsg_root.
--
-- Rollback (forward-only): a NEW migration restoring those bodies and the two
-- checks (only while no 'unknown' row exists).

begin;
set local lock_timeout = '15s';

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.customer_messages'::regclass and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) like '%''sending''::text, ''sent''::text%'
           or pg_get_constraintdef(con.oid) like '%''invalid_number''::text%')
      and pg_get_constraintdef(con.oid) not like '%next_attempt_at%'
  loop
    execute format('alter table public.customer_messages drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.customer_messages
  add constraint customer_messages_status_check
    check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'stopped', 'unknown')),
  add constraint customer_messages_last_error_code_check
    check (last_error_code in ('not_configured', 'rejected', 'provider_error', 'network', 'bad_response',
                               'bounced', 'invalid_number', 'expired', 'unknown_outcome'));

-- The original message of a "Send again" chain.
create function authz.cmsg_root(p_message uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select m.id, m.resend_of from public.customer_messages m where m.id = p_message
    union all
    select m.id, m.resend_of from public.customer_messages m join up on m.id = up.resend_of
  )
  select u.id from up u where u.resend_of is null limit 1
$$;
revoke all on function authz.cmsg_root(uuid) from public, anon, authenticated, service_role;

create or replace function authz.customer_messages_guard() returns trigger
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
  -- Accounts phase 3 (20261205000190): 'unknown' (the request left, no answer came back) and
  -- a delivery report for a queued or unknown row (sent after all).
  if new.status is distinct from old.status and not (
       (old.status = 'queued' and new.status in ('sending', 'sent', 'failed', 'skipped', 'stopped'))
    or (old.status = 'sending' and new.status in ('sent', 'failed', 'skipped', 'stopped', 'unknown'))
    or (old.status = 'unknown' and new.status = 'sent')
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

create or replace function public.customer_message_event_record(
  p_provider text, p_provider_event_id text, p_message_ref text, p_kind text, p_error_code text, p_mobile text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_event uuid;
  v_code text;
  v_deals uuid[];
  v_entities uuid[];
  v_entity uuid;
  v_new_entities uuid[] := '{}';
  v_id uuid;
  v_n integer := 0;
begin
  if p_provider is null or p_provider not in ('resend', 'interakt') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'provider';
  end if;
  if p_provider_event_id is null or length(p_provider_event_id) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'providerEventId';
  end if;
  if p_kind is null or p_kind not in ('sent', 'delivered', 'read', 'failed', 'bounced', 'complained', 'inbound_stop',
                                      'inbound_start', 'inbound_other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_kind in ('inbound_stop', 'inbound_start') and (p_mobile is null or p_mobile !~ '^[6-9][0-9]{9}$') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'mobile';
  end if;
  v_code := case
    when p_kind = 'bounced' then 'bounced'
    when p_error_code in ('rejected', 'provider_error', 'bounced', 'invalid_number', 'expired') then p_error_code
    when p_kind = 'failed' then 'provider_error' end;

  if p_kind not like 'inbound_%' and p_message_ref is not null then
    if p_message_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into v_msg from public.customer_messages m where m.id = p_message_ref::uuid for update;
    end if;
    if v_msg.id is null then
      select * into v_msg from public.customer_messages m
      where m.provider_message_id = p_message_ref and m.channel = case p_provider when 'resend' then 'email' else 'whatsapp' end
      for update;
    end if;
  end if;

  insert into public.customer_message_events (provider, provider_event_id, message_id, kind, error_code)
  values (p_provider, p_provider_event_id, v_msg.id, p_kind, v_code)
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event;
  if v_event is null then
    return jsonb_build_object('outcome', 'existing');
  end if;

  if v_msg.id is not null then
    -- Accounts phase 3 (20261205000190): a report for a queued (retry waiting) or unknown
    -- row means it was sent after all: sent, the retry is cleared.
    if p_kind in ('sent', 'delivered', 'read') and v_msg.status in ('queued', 'sending', 'unknown') then
      update public.customer_messages m
      set status = 'sent', sent_at = coalesce(m.sent_at, now()), lease_owner = null, lease_until = null,
          last_error_code = null, failed_at = null
      where m.id = v_msg.id returning * into v_msg;
    end if;
    if p_kind = 'delivered' and v_msg.status = 'sent' then
      update public.customer_messages m set status = 'delivered', delivered_at = now() where m.id = v_msg.id;
    elsif p_kind = 'read' and v_msg.status in ('sent', 'delivered') then
      update public.customer_messages m set status = 'read', read_at = now(),
        delivered_at = coalesce(m.delivered_at, now()) where m.id = v_msg.id;
    elsif p_kind in ('failed', 'bounced') and v_msg.status in ('queued', 'sending', 'sent') then
      -- Bounced or invalid: failed at once, no retry.
      update public.customer_messages m
      set status = 'failed', failed_at = now(), last_error_code = v_code, lease_owner = null, lease_until = null
      where m.id = v_msg.id;
      perform authz.cmsg_alert_failed(v_msg.id);
      perform authz.write_system_audit('messages.failed', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
        'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
          'channel', v_msg.channel, 'dealId', v_msg.deal_id, 'errorCode', v_code));
    end if;
    return jsonb_build_object('outcome', 'recorded', 'kind', p_kind, 'messageId', v_msg.id);
  end if;

  if p_kind in ('inbound_stop', 'inbound_start') then
    -- Deals whose WhatsApp number this is (Deal setting, else the confirmed booking contact).
    select coalesce(array_agg(distinct d.id), '{}'), coalesce(array_agg(distinct d.legal_entity_id), '{}')
      into v_deals, v_entities
    from public.deals d
    cross join lateral authz.cmsg_contact(d.id) c
    where d.id in (select p.deal_id from public.deal_message_prefs p where p.whatsapp_mobile = p_mobile
                   union
                   select bc.deal_id from public.booking_version_contacts bc
                   join public.booking_versions v on v.id = bc.booking_version_id and v.status = 'confirmed'
                   where bc.mobile = p_mobile and bc.contact_confirmed)
      and c.mobile = p_mobile;
    if cardinality(v_entities) = 0 then
      select coalesce(array_agg(s.legal_entity_id), '{}') into v_entities from public.customer_message_settings s;
    end if;

    if p_kind = 'inbound_stop' then
      foreach v_entity in array v_entities loop
        v_id := null;
        insert into public.customer_whatsapp_optouts (legal_entity_id, mobile, source, event_id)
        values (v_entity, p_mobile, 'stop_reply', v_event)
        on conflict (legal_entity_id, mobile) do update
          set opted_out_at = now(), source = 'stop_reply', event_id = excluded.event_id, restarted_at = null,
              restart_source = null, restarted_by = null, restart_event_id = null, updated_at = now()
          where public.customer_whatsapp_optouts.restarted_at is not null
        returning id into v_id;
        if v_id is not null then
          v_new_entities := v_new_entities || v_entity;
        end if;
      end loop;
      update public.customer_messages m set status = 'stopped', skip_reason = 'opted_out'
      where m.deal_id = any (v_deals) and m.channel = 'whatsapp' and m.status = 'queued';
      insert into public.customer_message_alerts (legal_entity_id, branch_id, deal_id, kind, event_id)
      select d.legal_entity_id, d.branch_id, d.id, 'whatsapp_stopped', v_event
      from public.deals d
      where d.id = any (v_deals)
        -- A repeated STOP while already opted out tells nobody again.
        and d.legal_entity_id = any (v_new_entities)
        and coalesce((select v.trip_end from public.booking_versions v where v.deal_id = d.id and v.status = 'confirmed'
                       order by v.version_no desc limit 1), authz.finance_today()) >= authz.finance_today()
      on conflict do nothing;
      get diagnostics v_n = row_count;
    else
      update public.customer_whatsapp_optouts o
      set restarted_at = now(), restart_source = 'start_reply', restart_event_id = v_event, updated_at = now()
      where o.mobile = p_mobile and o.restarted_at is null and o.legal_entity_id = any (v_entities);
    end if;
    return jsonb_build_object('outcome', 'recorded', 'kind', p_kind, 'deals', cardinality(v_deals), 'alerts', v_n);
  end if;
  return jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
end;
$$;

create or replace function public.customer_message_complete(
  p_id uuid, p_worker text, p_ok boolean, p_provider_message_id text, p_error_code text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_code text;
  v_final boolean;
begin
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  select * into v_msg from public.customer_messages m where m.id = p_id for update;
  if v_msg.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_msg.status <> 'sending' or v_msg.lease_owner is distinct from p_worker then
    if p_ok and v_msg.provider_message_id is not distinct from p_provider_message_id and v_msg.status in ('sent', 'delivered', 'read') then
      return jsonb_build_object('outcome', 'existing', 'status', v_msg.status);
    end if;
    -- A delivery report arrived before the worker finished: keep the provider id.
    if p_ok and v_msg.provider_message_id is null and v_msg.status in ('sent', 'delivered')
       and length(coalesce(p_provider_message_id, '')) between 1 and 200 then
      update public.customer_messages m set provider_message_id = p_provider_message_id, lease_owner = null, lease_until = null
      where m.id = v_msg.id;
      return jsonb_build_object('outcome', 'existing', 'status', v_msg.status);
    end if;
    -- The lease was lost (or a delivery report came first): nothing to do.
    return jsonb_build_object('outcome', 'stale', 'status', v_msg.status);
  end if;

  if p_ok then
    -- Accounts phase 3 (20261205000190): any 2xx answer is "sent"; the provider id is kept when there is one.
    if p_provider_message_id is not null and length(p_provider_message_id) not between 1 and 200 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'providerMessageId';
    end if;
    update public.customer_messages m
    set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id, last_error_code = null,
        lease_owner = null, lease_until = null
    where m.id = v_msg.id;
    perform authz.write_system_audit('messages.sent', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
      'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
        'channel', v_msg.channel, 'dealId', v_msg.deal_id));
    return jsonb_build_object('outcome', 'updated', 'status', 'sent');
  end if;

  v_code := case when p_error_code in ('not_configured', 'rejected', 'provider_error', 'network', 'bad_response', 'bounced',
                                         'invalid_number', 'expired', 'unknown_outcome') then p_error_code else 'provider_error' end;
  -- Accounts phase 3 (20261205000190): the request left and no answer came back: never retried
  -- automatically (it may have reached the customer). Staff check and may "Send again".
  if v_code = 'unknown_outcome' then
    update public.customer_messages m
    set status = 'unknown', failed_at = now(), last_error_code = v_code, lease_owner = null, lease_until = null
    where m.id = v_msg.id;
    perform authz.cmsg_alert_failed(v_msg.id);
    perform authz.write_system_audit('messages.failed', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
      'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
        'channel', v_msg.channel, 'dealId', v_msg.deal_id, 'errorCode', v_code));
    return jsonb_build_object('outcome', 'updated', 'status', 'unknown');
  end if;
  v_final := v_code in ('not_configured', 'rejected', 'bounced', 'invalid_number', 'expired') or v_msg.attempts >= 4;
  if not v_final then
    update public.customer_messages m
    set status = 'queued', last_error_code = v_code, lease_owner = null, lease_until = null,
        -- Accounts phase 3 (20261205000190): a retry of a quiet type waits for 08:00 India time too.
        next_attempt_at = authz.cmsg_not_before(m.message_type,
          now() + make_interval(mins => case m.attempts when 1 then 5 when 2 then 20 else 60 end))
    where m.id = v_msg.id;
    return jsonb_build_object('outcome', 'updated', 'status', 'queued', 'attempts', v_msg.attempts);
  end if;
  update public.customer_messages m
  set status = 'failed', failed_at = now(), last_error_code = v_code, lease_owner = null, lease_until = null
  where m.id = v_msg.id;
  -- A missing provider key is shown honestly on the Deal, without a notice per message.
  if v_code <> 'not_configured' then
    perform authz.cmsg_alert_failed(v_msg.id);
  end if;
  perform authz.write_system_audit('messages.failed', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
    'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
      'channel', v_msg.channel, 'dealId', v_msg.deal_id, 'errorCode', v_code));
  return jsonb_build_object('outcome', 'updated', 'status', 'failed');
end;
$$;

create or replace function authz.cmsg_can_resend(p_msg public.customer_messages) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select m.id, m.resend_of from public.customer_messages m where m.id = p_msg.id
    union all
    select m.id, m.resend_of from public.customer_messages m join up on m.id = up.resend_of
  ),
  down as (
    select m.id, m.status from public.customer_messages m
    where m.resend_of = (select u.id from up u where u.resend_of is null limit 1)
    union all
    select m.id, m.status from public.customer_messages m join down d on m.resend_of = d.id
  )
  select (p_msg.status in ('failed', 'unknown')
          or (p_msg.status = 'skipped' and p_msg.skip_reason = 'no_contact')
          or (p_msg.status = 'stopped' and not authz.cmsg_opted_out(p_msg.legal_entity_id,
                (select c.mobile from authz.cmsg_contact(p_msg.deal_id) c))))
     -- Accounts phase 3 (20261205000150): no live earlier re-send of the same original.
     -- Accounts phase 3 (20261205000190): an unknown re-send was checked by staff and is not live.
     and not exists (select 1 from down d where d.status not in ('failed', 'skipped', 'stopped', 'unknown'))
$$;

create or replace function public.customer_message_resend(p_message_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_new public.customer_messages%rowtype;
  v_key text;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_msg from public.customer_messages m where m.id = p_message_id;
  if v_msg.id is null or not authz.cmsg_can_act(v_msg.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_new from public.customer_messages m where m.deal_id = v_msg.deal_id and m.request_id = p_request_id;
  if v_new.id is not null then
    return jsonb_build_object('outcome', 'existing', 'messageId', v_new.id, 'status', v_new.status, 'skipReason', v_new.skip_reason);
  end if;
  -- Accounts phase 3 (20261205000190): two presses on the same chain are serialised by
  -- locking its root (the original message) before the check.
  perform 1 from public.customer_messages m where m.id = authz.cmsg_root(p_message_id) for update;
  select * into v_msg from public.customer_messages m where m.id = p_message_id for update;
  if not authz.cmsg_can_resend(v_msg)
     or not authz.cmsg_switch_on(v_msg.legal_entity_id, v_msg.message_type, v_msg.channel) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select count(*) + 1 into v_n from public.customer_messages r where r.resend_of = v_msg.id;
  v_key := v_msg.event_key || ':r' || v_n::text;
  if length(v_key) > 120 then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- All rules re-checked; base params (contact name, trip) read again.
  perform authz.cmsg_enqueue_core(v_msg.deal_id, v_msg.message_type, v_key,
    v_msg.params - array['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd', 'travellerCount'],
    v_msg.attachment, array[v_msg.channel], 'resend', v_msg.id, (select auth.uid()), p_request_id);
  select * into v_new from public.customer_messages m
  where m.deal_id = v_msg.deal_id and m.message_type = v_msg.message_type and m.channel = v_msg.channel and m.event_key = v_key;
  if v_new.id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.write_audit('messages.resent', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_new.id, null,
    jsonb_build_object('messageId', v_new.id, 'resendOf', v_msg.id, 'type', v_msg.message_type, 'channel', v_msg.channel,
      'dealId', v_msg.deal_id));
  return jsonb_build_object('outcome', 'created', 'messageId', v_new.id, 'status', v_new.status, 'skipReason', v_new.skip_reason);
end;
$$;

create or replace function public.deal_customer_messages(p_deal_id uuid) returns jsonb
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
      -- Accounts phase 3 (20261205000180): true while WhatsApp goes to the booking contact's mobile.
      'whatsappSameAsMobile', v_prefs.whatsapp_mobile is null,
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
          'can', jsonb_build_object('resend', v_act and m.status in ('failed', 'skipped', 'stopped', 'unknown')
                                     and authz.cmsg_can_resend(m)
                                     and authz.cmsg_switch_on(m.legal_entity_id, m.message_type, m.channel)))
        order by m.created_at desc, m.id desc)
      from public.customer_messages m
      where m.id in (select x.id from public.customer_messages x where x.deal_id = v_deal.id
                     order by x.created_at desc, x.id desc limit 100)), '[]'::jsonb),
    'can', jsonb_build_object('editPrefs', v_act, 'restartWhatsapp', v_act and v_opted));
end;
$$;

create or replace function authz.cmsg_send_state(p_deal uuid, p_entity uuid, p_type text, p_channel text, p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when m.status in ('queued', 'sending') then 'waiting'
      when m.status in ('sent', 'delivered', 'read') then 'sent'
      when m.status in ('failed', 'unknown') then 'failed'
      when m.skip_reason in ('channel_off_on_deal', 'opted_out', 'template_not_approved', 'test_deal', 'not_in_pilot', 'switched_off') then 'off'
      else 'not_sent' end
    from public.customer_messages m
    where m.deal_id = p_deal and m.message_type = p_type and m.channel = p_channel
      and (m.event_key = p_key or m.event_key like p_key || ':r%')
    order by m.created_at desc, m.id desc limit 1),
    case when authz.cmsg_switch_on(p_entity, p_type, p_channel) then 'not_sent' else 'off' end)
$$;

commit;
