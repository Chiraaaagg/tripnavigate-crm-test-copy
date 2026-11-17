-- TripNavigate CRM - Accounts phase 2, Track D (3 of 4): sound and pop-ups ON
-- by default (owner answer Q12, 11 November 2026).
-- Contract: accounts-phase2-2026-11-11/contract.md section 8.5 (frozen).
--
-- What this file changes:
--   1. staff_notice_preferences.sound_on defaults to true; new column
--      popups_on boolean not null default true. No data update: every
--      existing row was written by an explicit notice_preferences_set call
--      (the only writer, 20261203000420), so a saved choice stays as it is.
--   2. public.notice_preferences_get (replace 20261203000420, same
--      signature): {soundOn, popupsOn}; a person without a row reads ON.
--   3. public.notice_preferences_set (replace 20261203000420, same
--      signature): p_fields {soundOn?, popupsOn?} (at least one, booleans);
--      the upsert keeps the other value (a new row takes the default, ON).
--   public.notice_inbox returns popupsOn too (20261204000430).
--   Browser limits stay: sound only after the first click per page load;
--   the pop-up permission is asked by the browser once (client module
--   S/modules/notices/popup-policy.ts / popup-browser.ts).
--
-- Refusal tokens: not_authorized (42501), invalid_input (22023, hint
-- soundOn | popupsOn | fields).
-- Rollback (forward-only): a new migration restoring the 20261203000420
-- bodies and the old default; the column may stay.

begin;
set local lock_timeout = '15s';

alter table public.staff_notice_preferences alter column sound_on set default true;
alter table public.staff_notice_preferences add column popups_on boolean not null default true;
comment on table public.staff_notice_preferences is
  'Per-person bell preferences: sound and pop-ups ON by default (owner Q12, Accounts phase 2); a missing row reads ON. Written only by public.notice_preferences_set.';

create or replace function public.notice_preferences_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.staff_notice_preferences%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v from public.staff_notice_preferences p where p.user_id = (select auth.uid());
  -- Accounts phase 2 (20261204000420): no row = ON.
  return jsonb_build_object('soundOn', coalesce(v.sound_on, true), 'popupsOn', coalesce(v.popups_on, true));
end;
$$;

create or replace function public.notice_preferences_set(p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.staff_notice_preferences%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb
     or (p_fields - array['soundOn', 'popupsOn']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if p_fields ? 'soundOn' and jsonb_typeof(p_fields -> 'soundOn') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'soundOn';
  end if;
  if p_fields ? 'popupsOn' and jsonb_typeof(p_fields -> 'popupsOn') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'popupsOn';
  end if;
  insert into public.staff_notice_preferences as x (user_id, sound_on, popups_on, updated_at)
  values (v_uid, coalesce((p_fields ->> 'soundOn')::boolean, true), coalesce((p_fields ->> 'popupsOn')::boolean, true), now())
  on conflict (user_id) do update
    set sound_on = case when p_fields ? 'soundOn' then excluded.sound_on else x.sound_on end,
        popups_on = case when p_fields ? 'popupsOn' then excluded.popups_on else x.popups_on end,
        updated_at = excluded.updated_at
  returning * into v;
  return jsonb_build_object('soundOn', v.sound_on, 'popupsOn', v.popups_on);
end;
$$;

commit;
