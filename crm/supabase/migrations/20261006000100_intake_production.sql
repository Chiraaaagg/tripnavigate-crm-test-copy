-- TripNavigate CRM - Phase 5: least-privilege Bitrix receiver path (security
-- review M3) for production intake.
--
-- Plan: docs/implementation/phase-5/intake-plan.md. Not applied to any hosted
-- database by this change.
--
-- Problem (M3): the public Edge Function `bitrix-events` used a full secret
-- (service-role) key to read integration_intake_config and call
-- integration_record_bitrix_event. Any code-level flaw in that public function
-- would hold a key that bypasses RLS on every table.
--
-- What changes:
--   * public.integration_receiver_credentials: SHA-256 digests (never the
--     value) of the dedicated receiver credential INTAKE_RECEIVER_CREDENTIAL.
--     Two slots (1, 2) so a new credential can overlap the old one during
--     rotation; at most one ACTIVE row per slot. RLS on, no policy and no grant
--     for anon/authenticated/service_role: only the database owner writes it.
--   * public.integration_receive_bitrix_event(p_credential, p_member_id,
--     p_domain, p_event_type, p_deal_id, p_source_ts): security definer,
--     search_path ''. EXECUTE for anon only (the publishable key). It:
--       1. checks the receiver credential digest against an active row
--          (28000 'receiver not authorized'), BEFORE any intake table read;
--       2. checks deployment environment and portal identity: member_id AND
--          normalised domain must equal the single enabled config row
--          (55000 not configured; 42501 'portal not recognised');
--       3. delegates to public.integration_record_bitrix_event (unchanged:
--          dedupe key, coalescing into a pending row, bounded fields).
--     The function returns only {inboxId, duplicate}.
--   * The Edge Function now calls only this RPC with the publishable key and
--     the receiver credential. It never reads SUPABASE_SECRET_KEYS,
--     SUPABASE_SERVICE_ROLE_KEY or SUPABASE_DB_URL. Residual risk: the
--     Supabase platform still injects those keys into every function's
--     environment and they cannot be unset, so a runtime compromise (not a
--     code-path flaw) could still read them. See intake-plan.md section 4.
--   * Nothing else is granted to anon. integration_record_bitrix_event stays
--     service_role only (the local Vercel route and tests use it).
--
-- SQLSTATEs raised to the receiver:
--   28000  receiver credential missing, malformed, unknown or revoked -> 503
--   55000  environment 'unset' or no enabled config                   -> 503
--   42501  member_id/domain do not match the enabled config           -> 401
--   22023  invalid event type, deal id or timestamp                   -> 400/503
--
-- Stop switches (any one stops new inbox rows, no redeploy needed):
--   update public.integration_receiver_credentials set active = false, revoked_at = now();
--   update public.integration_intake_config set enabled = false;
--   update public.deployment_settings set environment = 'unset';
--
-- Rollback (forward-only): a NEW migration that revokes EXECUTE on
-- public.integration_receive_bitrix_event from anon (or drops the function)
-- and, if wanted, drops public.integration_receiver_credentials. No inbox,
-- deal or audit row is touched. Re-pointing the Edge Function at the old
-- service-key path is NOT a rollback option (it reintroduces M3); stop intake
-- instead and let reconciliation repair missed deals after the fix.

begin;

-- ---------------------------------------------------------------------------
-- Receiver credential digests (owner-only)
-- ---------------------------------------------------------------------------

create table public.integration_receiver_credentials (
  id uuid primary key default gen_random_uuid(),
  slot smallint not null check (slot in (1, 2)),
  -- sha256(convert_to(<credential>, 'UTF8')); the credential itself is never stored.
  credential_sha256 bytea not null unique check (octet_length(credential_sha256) = 32),
  active boolean not null default true,
  note text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (active or revoked_at is not null)
);
create unique index integration_receiver_credentials_active_slot_idx
  on public.integration_receiver_credentials (slot) where active;
comment on table public.integration_receiver_credentials is
  'SHA-256 digests of the Edge receiver credential (INTAKE_RECEIVER_CREDENTIAL). Owner-only; two slots for rotation.';

alter table public.integration_receiver_credentials enable row level security;
-- Same restrictive session barrier as every other table (defence in depth;
-- there is no permissive policy, so nothing is visible through the Data API).
create policy require_valid_session on public.integration_receiver_credentials
  as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.integration_receiver_credentials from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers (not callable by API roles)
-- ---------------------------------------------------------------------------

create function authz.intake_receiver_authorized(p_credential text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_credential is not null
    and length(p_credential) between 32 and 256
    and exists (
      select 1 from public.integration_receiver_credentials c
      where c.active and c.credential_sha256 = sha256(convert_to(p_credential, 'UTF8'))
    )
$$;

create function authz.normalise_portal_domain(p_domain text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(lower(btrim(p_domain)), '\.$', '')
$$;

revoke all on function authz.intake_receiver_authorized(text), authz.normalise_portal_domain(text)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Least-privilege receiver command
-- ---------------------------------------------------------------------------

create function public.integration_receive_bitrix_event(
  p_credential text, p_member_id text, p_domain text, p_event_type text, p_deal_id bigint, p_source_ts bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_enabled integer;
  v_match boolean;
  v_result jsonb;
begin
  -- 1. Receiver credential first: nothing else is read for an unknown caller.
  if not authz.intake_receiver_authorized(p_credential) then
    raise exception 'receiver not authorized' using errcode = '28000';
  end if;

  -- 2. Environment and portal identity (member_id AND domain) from configuration.
  if authz.deployment_environment() = 'unset' then
    raise exception 'intake is not configured (environment unset)' using errcode = '55000';
  end if;
  select count(*)::integer,
         bool_or(c.portal_member_id = p_member_id
                 and c.portal_domain = authz.normalise_portal_domain(p_domain))
    into v_enabled, v_match
  from public.integration_intake_config c
  where c.enabled;
  -- None enabled, or more than one (ambiguous: one REST credential per deployment).
  if v_enabled <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  if p_member_id is null or p_domain is null or length(p_domain) > 253 or not coalesce(v_match, false) then
    raise exception 'portal not recognised' using errcode = '42501';
  end if;

  -- 3. Existing durable record (dedupe, coalescing, argument checks).
  v_result := public.integration_record_bitrix_event(p_member_id, p_event_type, p_deal_id, p_source_ts);
  return jsonb_build_object('inboxId', v_result -> 'inboxId', 'duplicate', v_result -> 'duplicate');
end;
$$;

comment on function public.integration_receive_bitrix_event(text, text, text, text, bigint, bigint) is
  'Edge receiver entry (publishable key + receiver credential). Records one Bitrix deal event; returns {inboxId, duplicate}.';

revoke all on function public.integration_receive_bitrix_event(text, text, text, text, bigint, bigint)
from public, anon, authenticated, service_role;
grant execute on function public.integration_receive_bitrix_event(text, text, text, text, bigint, bigint) to anon;

commit;
