-- TripNavigate CRM - Accounts phase 3, track A fix-forward (independent UI
-- review, 13 Nov 2026): the Deal card must know whether WhatsApp goes to a
-- separate number, so saving another setting never wipes it.
--
-- public.deal_customer_messages (replaces 20261205000140, same signature):
-- additive key prefs.whatsappSameAsMobile (true while no separate WhatsApp
-- number is set). deal_message_prefs_set is unchanged: it keeps the stored
-- number whenever whatsappSameAsMobile is absent from p_fields, and clears it
-- only when whatsappSameAsMobile is true.
--
-- Rollback (forward-only): a NEW migration restoring the 20261205000140 body.

begin;
set local lock_timeout = '15s';

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

commit;
