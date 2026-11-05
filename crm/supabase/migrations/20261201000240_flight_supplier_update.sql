-- Flight build, Track B (5): Flight edits and archives its own suppliers
-- (lead L15, 4 Nov 2026). Since 20261201000230 Purchase's supplier_update
-- refuses suppliers serving flights; this is their edit command.
--
--   public.flight_supplier_update(p_supplier_id uuid, p_expected_row_version
--     integer, p_fields jsonb) returns jsonb {supplierId, rowVersion}
--   Caller: an active Flight person of the supplier's entity. Supplier:
--   service_types = {flight} only. Fields (all sent each time, unknown keys
--   refused): name (1..200, unique per entity ignoring case), city,
--   contactName, contactPhone, contactEmail, status ('active'|'archived',
--   optional = unchanged). Service types stay {flight}. As supplier_update: a
--   change of details sets the supplier back to unverified; the audit row
--   'supplier.updated' carries field names only. Bank details and their
--   approval (supplier_approve_beneficiary) are unchanged.
--   Refusals: 42501 not_authorized | 55000 environment_unset | 40001
--   version_changed | 22023 invalid_input (hint = field) | 23505
--   duplicate_supplier.
--
--   flight_supplier_list() (replaces 20261201000220) adds what the edit form
--   needs: contactName, contactPhone, contactEmail, rowVersion. No bank values.
--
-- Rollback (forward-only): a NEW migration revoking execute on the command
-- and restoring flight_supplier_list from 20261201000220.

begin;
set local lock_timeout = '15s';

create function public.flight_supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_city text;
  v_contact text;
  v_phone text;
  v_email text;
  v_details_changed boolean;
  v_reset boolean;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('flight', v_s.legal_entity_id) or v_s.service_types <> array['flight'] then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'city', 'contactName', 'contactPhone', 'contactEmail', 'status']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end;
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  begin
    v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end;
  if v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end if;
  begin
    v_city := authz.booking_fact_text(p_fields, 'city', 120, false);
    v_contact := authz.booking_fact_text(p_fields, 'contactName', 120, false);
    v_phone := authz.booking_fact_text(p_fields, 'contactPhone', 40, false);
    v_email := authz.booking_fact_text(p_fields, 'contactEmail', 254, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'duplicate_supplier' using errcode = '23505';
  end if;
  v_details_changed := (v_name, v_city, v_contact, v_phone, v_email)
    is distinct from (v_s.name, v_s.city, v_s.contact_name, v_s.contact_phone, v_s.contact_email);
  v_reset := v_details_changed and v_s.verification_status = 'verified';

  begin
    update public.suppliers s set
      name = v_name,
      city = v_city,
      contact_name = v_contact,
      contact_phone = v_phone,
      contact_email = v_email,
      status = v_status,
      verification_status = case when v_details_changed then 'unverified' else s.verification_status end,
      verified_by = case when v_details_changed then null else s.verified_by end,
      verified_at = case when v_details_changed then null else s.verified_at end,
      row_version = s.row_version + 1,
      updated_by = case when v_details_changed then (select auth.uid()) else s.updated_by end,
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'duplicate_supplier' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status,
      'detailsChanged', v_details_changed, 'verificationReset', v_reset, 'department', 'flight'));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version);
end;
$$;

create or replace function public.flight_supplier_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'supplierId', s.id,
      'name', s.name,
      'city', s.city,
      'status', s.status,
      'bankDetailsApproved', authz.sm_bank_approved(s.id),
      'verification', s.verification_status,
      'contactName', s.contact_name,
      'contactPhone', s.contact_phone,
      'contactEmail', s.contact_email,
      'rowVersion', s.row_version) order by s.status, lower(s.name), s.id)
    from public.suppliers s
    where s.service_types @> array['flight'] and authz.holds_active_role('flight', s.legal_entity_id)), '[]'::jsonb);
end;
$$;

revoke all on function public.flight_supplier_update(uuid, integer, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.flight_supplier_update(uuid, integer, jsonb) to authenticated;

commit;
