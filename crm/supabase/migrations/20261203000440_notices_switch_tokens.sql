-- TripNavigate CRM - Accounts phase, track C fix-forward: refusal tokens of the
-- notices switch setter.
-- Contract: accounts-phase-2026-11-10/contract.md sections 6.3.3 and 7.7.
--
-- public.admin_set_notices_enabled (replaces 20261203000400, same signature)
-- copied the wording of admin_set_supplier_email_sending ('not authorized',
-- 'a reason of 10 to 500 characters is required', 'invalid switch'). It now
-- raises the contract's refusal tokens: not_authorized (42501), invalid_input
-- (22023, hint 'reason' or 'enabled'). Behaviour, audit (settings.notices_changed
-- through the trigger) and the result shape are unchanged.
--
-- Rollback (forward-only): a new migration restoring the 20261203000400 body.

begin;
set local lock_timeout = '15s';

create or replace function public.admin_set_notices_enabled(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.notice_settings%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_prev text[];
begin
  -- Accounts phase (20261203000440): contract refusal tokens.
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select s.notices_enabled into v_before from public.notice_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_notices_enabled', v_reason);
  update public.notice_settings s set notices_enabled = p_enabled, updated_by = (select auth.uid())
  where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);

  return jsonb_build_object('changed', v_before is distinct from v_after.notices_enabled,
    'before', v_before, 'after', v_after.notices_enabled, 'updatedAt', v_after.updated_at);
end;
$$;

commit;
