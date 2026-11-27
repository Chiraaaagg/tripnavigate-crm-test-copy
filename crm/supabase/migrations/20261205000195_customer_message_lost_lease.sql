-- TripNavigate CRM - Accounts phase 3, track A fix-forward (PR review,
-- contract Addendum O3): WhatsApp can never be sent twice after a lost lease.
--
-- 1. public.customer_message_claim (replaces 20261205000120, same signature):
--    an expired 'sending' WhatsApp row becomes 'unknown' (unknown_outcome;
--    message_failed alert and messages.failed audit as Addendum L11; never
--    re-sent automatically). An expired 'sending' e-mail is claimed again as
--    before (the Resend idempotency key is the message id).
-- 2. public.customer_message_release(p_ids uuid[], p_worker text)
--    (service_role only): rows the worker claimed but never started go back
--    to 'queued' (same lease owner, still 'sending'; the attempt is given
--    back). Returns {released}.
-- 3. authz.customer_messages_guard (replaces 20261205000190): allows that
--    release (sending -> queued with attempts - 1).
--
-- Rollback (forward-only): a NEW migration restoring the 0120 claim and the
-- 0190 guard and dropping customer_message_release.

begin;
set local lock_timeout = '15s';

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
    -- Accounts phase 3 (20261205000195): or released unstarted by its worker (the attempt is given back).
    or (old.status = 'sending' and new.status = 'queued' and (new.attempts > 0 or new.attempts = old.attempts - 1))
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

create or replace function public.customer_message_claim(p_worker text, p_limit integer, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_reason text;
  v_file jsonb;
  c record;
  v_out jsonb := '[]'::jsonb;
begin
  if p_worker is null or length(p_worker) not between 1 and 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'worker';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'leaseSeconds';
  end if;
  for v_msg in
    select * from public.customer_messages m
    where m.status in ('queued', 'sending') and m.next_attempt_at <= now() and m.not_before <= now()
      and (m.status = 'queued' or m.lease_until < now())
    order by m.next_attempt_at, m.id
    limit p_limit
    for update skip locked
  loop
    -- Accounts phase 3 (20261205000195): a WhatsApp message whose lease ran out may have
    -- reached the customer (the worker died after sending): unknown, never sent
    -- again by itself (alert; staff check and may Send again). An e-mail is
    -- claimed again: Resend's idempotency key (the message id) stops a double.
    if v_msg.status = 'sending' and v_msg.channel = 'whatsapp' then
      update public.customer_messages m
      set status = 'unknown', failed_at = now(), last_error_code = 'unknown_outcome', lease_owner = null, lease_until = null
      where m.id = v_msg.id;
      perform authz.cmsg_alert_failed(v_msg.id);
      perform authz.write_system_audit('messages.failed', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
        'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
          'channel', v_msg.channel, 'dealId', v_msg.deal_id, 'errorCode', 'unknown_outcome'));
      continue;
    end if;
    -- A lease that ran out after the last allowed attempt: failed.
    if v_msg.status = 'sending' and v_msg.attempts >= 4 then
      update public.customer_messages m set status = 'failed', failed_at = now(), last_error_code = 'expired',
        lease_owner = null, lease_until = null where m.id = v_msg.id;
      perform authz.cmsg_alert_failed(v_msg.id);
      continue;
    end if;
    -- A switch turned Off after queueing wins: the message is not sent.
    v_reason := case when not authz.cmsg_switch_on(v_msg.legal_entity_id, v_msg.message_type, v_msg.channel) then 'switched_off'
                     else authz.cmsg_skip_reason(v_msg.deal_id, v_msg.message_type, v_msg.channel) end;
    v_file := null;
    if v_reason is null and v_msg.attachment is not null then
      v_file := authz.cmsg_attachment_file(v_msg.attachment);
      if v_file is null then
        v_reason := 'file_missing';
      end if;
    end if;
    if v_reason is not null then
      update public.customer_messages m
      set status = case when v_reason = 'opted_out' then 'stopped' else 'skipped' end, skip_reason = v_reason,
          lease_owner = null, lease_until = null
      where m.id = v_msg.id;
      continue;
    end if;
    select * into c from authz.cmsg_contact(v_msg.deal_id);
    update public.customer_messages m
    set status = 'sending', attempts = least(m.attempts + 1, 4), lease_owner = p_worker,
        lease_until = now() + make_interval(secs => p_lease_seconds),
        to_masked = case m.channel when 'email' then authz.cmsg_mask_email(c.email) else authz.cmsg_mask_mobile(c.mobile) end
    where m.id = v_msg.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_msg.id, 'channel', v_msg.channel, 'type', v_msg.message_type, 'language', v_msg.language,
      'templateCode', v_msg.template_code, 'params', v_msg.params, 'attachment', v_file, 'dealId', v_msg.deal_id,
      'to', case v_msg.channel when 'email' then c.email else c.mobile end,
      'replyTo', case v_msg.channel when 'email' then authz.cmsg_reply_to(v_msg.deal_id) end));
  end loop;
  return v_out;
end;
$$;

create function public.customer_message_release(p_ids uuid[], p_worker text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if p_worker is null or length(p_worker) not between 1 and 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'worker';
  end if;
  if p_ids is null or cardinality(p_ids) > 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ids';
  end if;
  update public.customer_messages m
  set status = 'queued', attempts = greatest(m.attempts - 1, 0), lease_owner = null, lease_until = null
  where m.id = any (p_ids) and m.status = 'sending' and m.lease_owner = p_worker;
  get diagnostics v_n = row_count;
  return jsonb_build_object('released', v_n);
end;
$$;

revoke all on function public.customer_message_release(uuid[], text) from public, anon, authenticated, service_role;
grant execute on function public.customer_message_release(uuid[], text) to service_role;

commit;
