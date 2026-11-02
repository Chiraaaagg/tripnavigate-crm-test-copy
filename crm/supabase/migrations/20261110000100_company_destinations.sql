-- Stage 2: versioned company bank and UPI destinations
-- (docs/implementation/next/stage-2-company-destinations-contract-2026-10-08.md and
-- stage-2-implementation-addendum-2026-10-08.md). Created with the pinned CLI,
-- then ordered after 20261105000100 before any application. Forward-only.
--
-- Accounts creates immutable numbered versions; a different Accounts person
-- approves or returns the exact version. Only the approved current version of
-- a non-retired destination is selectable for a new bank-transfer or UPI
-- receipt, which stores the version ID and an immutable snapshot. Existing
-- receipts stay unmapped. Account numbers and UPI IDs never appear in audit
-- rows, stored command results, lists, receipt views or error messages.
begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.company_destinations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  kind text not null check (kind in ('bank', 'upi')),
  label text not null check (length(label) between 1 and 80),
  -- Set from the deployment environment at creation; a receipt may only use a
  -- destination whose flag equals its deal's.
  is_synthetic boolean not null,
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  current_version_id uuid,
  retired_at timestamptz,
  retired_by uuid references public.staff_profiles (user_id),
  retire_reason text check (retire_reason is null or length(retire_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  unique (legal_entity_id, id),
  check ((retired_at is null) = (retired_by is null) and (retired_at is null) = (retire_reason is null))
);
comment on table public.company_destinations is
  'Company bank/UPI destinations (Stage 2). Values live only in company_destination_versions; never exposed to the Data API.';

create table public.company_destination_versions (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  destination_id uuid not null,
  version_no integer not null check (version_no >= 1),
  predecessor_version_id uuid references public.company_destination_versions (id),
  holder_name text,
  bank_name text,
  account_number text,
  ifsc text,
  payee_name text,
  upi_id text,
  status text not null default 'submitted' check (status in ('submitted', 'returned', 'approved', 'superseded')),
  maker uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  request_id uuid not null,
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  decision_reason text,
  unique (destination_id, version_no),
  unique (legal_entity_id, id),
  unique (destination_id, id),
  foreign key (legal_entity_id, destination_id) references public.company_destinations (legal_entity_id, id),
  check (decided_by is null or decided_by <> maker),
  check ((decided_by is null) = (decided_at is null))
);
-- A concurrency limit, not a business rule: one open version per destination
-- keeps approval unambiguous.
create unique index company_destination_versions_one_submitted
  on public.company_destination_versions (destination_id) where status = 'submitted';
create index company_destination_versions_entity_idx on public.company_destination_versions (legal_entity_id);
create index company_destinations_entity_idx on public.company_destinations (legal_entity_id);

-- The current version must belong to this destination (and so to its entity).
alter table public.company_destinations
  add constraint company_destinations_current_version_fk
  foreign key (id, current_version_id) references public.company_destination_versions (destination_id, id);

-- Receipts: the selected version and an immutable snapshot. The existing
-- receipt guard already makes every column outside its mutable list immutable.
alter table public.customer_receipts
  add column destination_version_id uuid,
  add column destination_snapshot jsonb;
alter table public.customer_receipts
  add constraint customer_receipts_destination_pair
    check ((destination_version_id is null) = (destination_snapshot is null)),
  add constraint customer_receipts_destination_mode
    check (destination_version_id is null or mode in ('bank_transfer', 'upi')),
  add constraint customer_receipts_destination_fk
    foreign key (legal_entity_id, destination_version_id)
    references public.company_destination_versions (legal_entity_id, id);
create index customer_receipts_destination_version_idx on public.customer_receipts (destination_version_id)
  where destination_version_id is not null;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

create function authz.company_destinations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['current_version_id', 'retired_at', 'retired_by', 'retire_reason', 'row_version', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'company destinations cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'company destination facts are immutable' using errcode = '42501';
  end if;
  if old.retired_at is not null and (new.retired_at, new.retired_by, new.retire_reason)
       is distinct from (old.retired_at, old.retired_by, old.retire_reason) then
    raise exception 'a retirement is permanent' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger company_destinations_a_guard before update or delete on public.company_destinations
  for each row execute function authz.company_destinations_guard();

create function authz.company_destination_versions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'decided_by', 'decided_at', 'decision_reason'];
begin
  if tg_op = 'DELETE' then
    raise exception 'destination versions cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'destination version values are immutable' using errcode = '42501';
  end if;
  if old.decided_by is not null and (new.decided_by, new.decided_at, new.decision_reason)
       is distinct from (old.decided_by, old.decided_at, old.decision_reason) then
    raise exception 'a decision is permanent' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and (old.status, new.status) not in (
       ('submitted', 'approved'), ('submitted', 'returned'), ('approved', 'superseded')) then
    raise exception 'destination version status % cannot become %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger company_destination_versions_a_guard before update or delete on public.company_destination_versions
  for each row execute function authz.company_destination_versions_guard();

-- Backstop: every new bank-transfer or UPI receipt names a destination
-- version. Existing receipts are untouched (insert-only check).
create function authz.customer_receipts_destination_required() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode in ('bank_transfer', 'upi') and new.destination_version_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger customer_receipts_b_destination_required before insert on public.customer_receipts
  for each row execute function authz.customer_receipts_destination_required();

-- ---------------------------------------------------------------------------
-- Helpers (values are validated here, before any insert, so a constraint
-- error can never echo them)
-- ---------------------------------------------------------------------------

create function authz.destination_mask_account(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case when p_value is null then null else 'XXXX' || right(p_value, 4) end
$$;

create function authz.destination_mask_upi(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case when p_value is null or position('@' in p_value) = 0 then null
    else left(p_value, 1) || '***@' || split_part(p_value, '@', 2) end
$$;

-- Destination values from p_fields for p_kind, normalised; invalid_input otherwise.
create function authz.destination_values(p_kind text, p_fields jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_holder text;
  v_bank text;
  v_account text;
  v_ifsc text;
  v_payee text;
  v_upi text;
begin
  if p_kind = 'bank' then
    v_holder := authz.finance_text(authz.finance_field(p_fields, 'holderName'), 1, 120, false);
    v_bank := authz.finance_text(authz.finance_field(p_fields, 'bankName'), 1, 120, false);
    v_account := replace(coalesce(authz.finance_field(p_fields, 'accountNumber'), ''), ' ', '');
    v_ifsc := upper(btrim(coalesce(authz.finance_field(p_fields, 'ifsc'), '')));
    if v_holder is null or v_bank is null or v_account !~ '^[0-9]{9,18}$' or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
       or authz.finance_field(p_fields, 'payeeName') is not null or authz.finance_field(p_fields, 'upiId') is not null then
      perform authz.finance_invalid();
    end if;
    return jsonb_build_object('holderName', v_holder, 'bankName', v_bank, 'accountNumber', v_account, 'ifsc', v_ifsc);
  elsif p_kind = 'upi' then
    v_payee := authz.finance_text(authz.finance_field(p_fields, 'payeeName'), 1, 120, false);
    v_upi := lower(btrim(coalesce(authz.finance_field(p_fields, 'upiId'), '')));
    if v_payee is null or v_upi !~ '^[a-z0-9._-]{2,100}@[a-z]{2,64}$'
       or authz.finance_field(p_fields, 'holderName') is not null or authz.finance_field(p_fields, 'bankName') is not null
       or authz.finance_field(p_fields, 'accountNumber') is not null or authz.finance_field(p_fields, 'ifsc') is not null then
      perform authz.finance_invalid();
    end if;
    return jsonb_build_object('payeeName', v_payee, 'upiId', v_upi);
  end if;
  perform authz.finance_invalid();
  return null;
end;
$$;

-- Masked summary of one version (no account number or UPI ID).
create function authz.destination_version_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'versionId', v.id,
    'versionNo', v.version_no,
    'status', v.status,
    'predecessorVersionNo', (select p.version_no from public.company_destination_versions p where p.id = v.predecessor_version_id),
    'holderName', v.holder_name,
    'bankName', v.bank_name,
    'accountMasked', authz.destination_mask_account(v.account_number),
    'ifsc', v.ifsc,
    'payeeName', v.payee_name,
    'upiMasked', authz.destination_mask_upi(v.upi_id),
    'makerId', v.maker,
    'makerName', authz.finance_name(v.maker),
    'createdAt', v.created_at,
    'decidedByName', authz.finance_name(v.decided_by),
    'decidedAt', v.decided_at,
    'decisionReason', v.decision_reason)
  from public.company_destination_versions v where v.id = p_version
$$;

-- One destination for the caller: state, masked versions and the caller's actions.
create function authz.destination_json(p_destination uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with d as (select * from public.company_destinations where id = p_destination),
  open_version as (
    select v.* from public.company_destination_versions v join d on v.destination_id = d.id where v.status = 'submitted'),
  latest as (
    select v.* from public.company_destination_versions v join d on v.destination_id = d.id order by v.version_no desc limit 1)
  select jsonb_build_object(
    'destinationId', d.id,
    'kind', d.kind,
    'label', d.label,
    'rowVersion', d.row_version,
    'state', case when d.retired_at is not null then 'retired'
                  when d.current_version_id is not null then 'approved'
                  else (select l.status from latest l) end,
    'createdByName', authz.finance_name(d.created_by),
    'createdAt', d.created_at,
    'retiredAt', d.retired_at,
    'retiredByName', authz.finance_name(d.retired_by),
    'retireReason', d.retire_reason,
    'current', case when d.current_version_id is null then null else authz.destination_version_json(d.current_version_id) end,
    'pending', (select authz.destination_version_json(o.id) from open_version o),
    'latestVersionNo', (select l.version_no from latest l),
    'versions', coalesce((select jsonb_agg(authz.destination_version_json(v.id) order by v.version_no desc)
                          from public.company_destination_versions v where v.destination_id = d.id), '[]'::jsonb),
    'actions', jsonb_build_object(
      'submit', case when d.retired_at is not null or exists (select 1 from open_version) then 'wrong_state' end,
      'decide', case when not exists (select 1 from open_version) then 'wrong_state'
                     when (select o.maker from open_version o) = (select auth.uid()) then 'own_record' end,
      'retire', case when d.retired_at is not null then 'wrong_state' end))
  from d
$$;

-- Destination row for a version-targeted command: missing looks unauthorized.
create function authz.destination_entity_of_version(p_version uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select v.legal_entity_id from public.company_destination_versions v where v.id = p_version
$$;

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------

create function public.company_destination_submit(
  p_entity_id uuid, p_destination_id uuid, p_fields jsonb, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('entityId', p_entity_id, 'destinationId', p_destination_id, 'fields', p_fields,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_dest public.company_destinations%rowtype;
  v_prev public.company_destination_versions%rowtype;
  v_kind text;
  v_label text;
  v_values jsonb;
  v_version uuid := gen_random_uuid();
  v_version_no integer := 1;
  v_changed text[] := '{}';
  v_key text;
begin
  perform authz.finance_require_accounts(p_entity_id, null);
  if p_request_id is null or p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.finance_invalid();
  end if;
  if p_destination_id is not null then
    select * into v_dest from public.company_destinations d
    where d.id = p_destination_id and d.legal_entity_id = p_entity_id for update;
    if v_dest.id is null then
      perform authz.finance_invalid();
    end if;
  end if;
  v_result := authz.finance_replay(p_entity_id, p_request_id, 'company_destination_submit', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if (p_fields - array['kind', 'label', 'holderName', 'bankName', 'accountNumber', 'ifsc', 'payeeName', 'upiId'])
     <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;

  if v_dest.id is null then
    v_kind := authz.finance_field(p_fields, 'kind');
    v_label := authz.finance_text(authz.finance_field(p_fields, 'label'), 1, 80, false);
    -- Separators are ignored, so a label can never carry an account number or UPI ID.
    if v_kind is null or v_kind not in ('bank', 'upi') or v_label is null
       or regexp_replace(v_label, '[[:space:]./_-]', '', 'g') ~ '[0-9]{6,}' or position('@' in v_label) > 0 then
      perform authz.finance_invalid();
    end if;
  else
    if authz.finance_field(p_fields, 'kind') is not null or authz.finance_field(p_fields, 'label') is not null then
      perform authz.finance_invalid();
    end if;
    v_kind := v_dest.kind;
    if p_expected_row_version is distinct from v_dest.row_version then
      raise exception 'version_changed' using errcode = '40001';
    end if;
    if v_dest.retired_at is not null or exists (
         select 1 from public.company_destination_versions v where v.destination_id = v_dest.id and v.status = 'submitted') then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    select * into v_prev from public.company_destination_versions v
    where v.destination_id = v_dest.id order by v.version_no desc limit 1;
    v_version_no := v_prev.version_no + 1;
  end if;
  v_values := authz.destination_values(v_kind, p_fields - array['kind', 'label']);

  begin
    if v_dest.id is null then
      insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
      values (p_entity_id, v_kind, v_label, authz.deployment_environment() = 'test', (select auth.uid()))
      returning * into v_dest;
    else
      update public.company_destinations d set row_version = d.row_version + 1, updated_at = now()
      where d.id = v_dest.id returning * into v_dest;
    end if;
    insert into public.company_destination_versions (id, legal_entity_id, destination_id, version_no, predecessor_version_id,
      holder_name, bank_name, account_number, ifsc, payee_name, upi_id, maker, request_id)
    values (v_version, p_entity_id, v_dest.id, v_version_no, v_prev.id,
      v_values ->> 'holderName', v_values ->> 'bankName', v_values ->> 'accountNumber', v_values ->> 'ifsc',
      v_values ->> 'payeeName', v_values ->> 'upiId', (select auth.uid()), p_request_id);
  exception
    when unique_violation then
      raise exception 'wrong_state' using errcode = '55000';
    when check_violation or not_null_violation or foreign_key_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  -- Changed field NAMES only (never values) for the audit trail.
  if v_prev.id is not null then
    foreach v_key in array array['holderName', 'bankName', 'accountNumber', 'ifsc', 'payeeName', 'upiId'] loop
      if (v_values ->> v_key) is distinct from (case v_key
            when 'holderName' then v_prev.holder_name when 'bankName' then v_prev.bank_name
            when 'accountNumber' then v_prev.account_number when 'ifsc' then v_prev.ifsc
            when 'payeeName' then v_prev.payee_name else v_prev.upi_id end) then
        v_changed := v_changed || v_key;
      end if;
    end loop;
  end if;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_version, 'destinationId', v_dest.id, 'versionId', v_version,
    'versionNo', v_version_no, 'status', 'submitted', 'rowVersion', v_dest.row_version);
  perform authz.finance_remember(p_entity_id, p_request_id, 'company_destination_submit', v_payload, v_result);
  perform authz.write_audit('finance.destination_submitted', p_entity_id, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('versionId', v_version, 'versionNo', v_version_no, 'kind', v_kind, 'changedFields', to_jsonb(v_changed)));
  return v_result;
end;
$$;

-- Shared start of approve/return: authorize (a missing version looks
-- unauthorized), then lock the destination, then the version.
create function authz.destination_lock_for_decision(p_version uuid) returns public.company_destination_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.company_destination_versions%rowtype;
begin
  perform authz.finance_require_accounts(authz.destination_entity_of_version(p_version), null);
  select * into v from public.company_destination_versions x where x.id = p_version;
  perform 1 from public.company_destinations d where d.id = v.destination_id for update;
  select * into v from public.company_destination_versions x where x.id = p_version for update;
  return v;
end;
$$;

create function public.company_destination_approve(p_version_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dest public.company_destinations%rowtype;
  v_ver public.company_destination_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_previous uuid;
begin
  v_ver := authz.destination_lock_for_decision(p_version_id);
  select * into v_dest from public.company_destinations d where d.id = v_ver.destination_id;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_result := authz.finance_replay(v_dest.legal_entity_id, p_request_id, 'company_destination_approve', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is distinct from v_dest.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_ver.status <> 'submitted' or v_dest.retired_at is not null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_ver.maker = (select auth.uid()) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;

  v_previous := v_dest.current_version_id;
  if v_previous is not null then
    update public.company_destination_versions v set status = 'superseded' where v.id = v_previous;
  end if;
  update public.company_destination_versions v
  set status = 'approved', decided_by = (select auth.uid()), decided_at = now()
  where v.id = v_ver.id;
  update public.company_destinations d
  set current_version_id = v_ver.id, row_version = d.row_version + 1, updated_at = now()
  where d.id = v_dest.id returning * into v_dest;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_ver.id, 'destinationId', v_dest.id, 'versionId', v_ver.id,
    'versionNo', v_ver.version_no, 'status', 'approved', 'rowVersion', v_dest.row_version);
  perform authz.finance_remember(v_dest.legal_entity_id, p_request_id, 'company_destination_approve', v_payload, v_result);
  perform authz.write_audit('finance.destination_approved', v_dest.legal_entity_id, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'supersededVersionId', v_previous));
  return v_result;
end;
$$;

create function public.company_destination_return(
  p_version_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dest public.company_destinations%rowtype;
  v_ver public.company_destination_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  v_ver := authz.destination_lock_for_decision(p_version_id);
  select * into v_dest from public.company_destinations d where d.id = v_ver.destination_id;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_result := authz.finance_replay(v_dest.legal_entity_id, p_request_id, 'company_destination_return', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  v_reason := authz.finance_reason(p_reason);
  if p_expected_row_version is distinct from v_dest.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_ver.status <> 'submitted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_ver.maker = (select auth.uid()) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;

  update public.company_destination_versions v
  set status = 'returned', decided_by = (select auth.uid()), decided_at = now(), decision_reason = v_reason
  where v.id = v_ver.id;
  update public.company_destinations d set row_version = d.row_version + 1, updated_at = now()
  where d.id = v_dest.id returning * into v_dest;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_ver.id, 'destinationId', v_dest.id, 'versionId', v_ver.id,
    'versionNo', v_ver.version_no, 'status', 'returned', 'rowVersion', v_dest.row_version);
  perform authz.finance_remember(v_dest.legal_entity_id, p_request_id, 'company_destination_return', v_payload, v_result);
  perform authz.write_audit('finance.destination_returned', v_dest.legal_entity_id, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no));
  return v_result;
end;
$$;

create function public.company_destination_retire(
  p_destination_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dest public.company_destinations%rowtype;
  v_entity uuid;
  v_payload jsonb := jsonb_build_object('destinationId', p_destination_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  select d.legal_entity_id into v_entity from public.company_destinations d where d.id = p_destination_id;
  perform authz.finance_require_accounts(v_entity, null);
  select * into v_dest from public.company_destinations d where d.id = p_destination_id for update;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_result := authz.finance_replay(v_entity, p_request_id, 'company_destination_retire', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  v_reason := authz.finance_reason(p_reason);
  if p_expected_row_version is distinct from v_dest.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_dest.retired_at is not null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  update public.company_destinations d
  set retired_at = now(), retired_by = (select auth.uid()), retire_reason = v_reason,
      row_version = d.row_version + 1, updated_at = now()
  where d.id = v_dest.id returning * into v_dest;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_dest.id, 'destinationId', v_dest.id, 'status', 'retired',
    'rowVersion', v_dest.row_version);
  perform authz.finance_remember(v_entity, p_request_id, 'company_destination_retire', v_payload, v_result);
  perform authz.write_audit('finance.destination_retired', v_entity, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('currentVersionId', v_dest.current_version_id));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- Masked list for Accounts in one entity.
create function public.company_destinations_list(p_entity_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform authz.finance_require_accounts(p_entity_id, null);
  return jsonb_build_object(
    'entityId', p_entity_id,
    'destinations', coalesce((
      select jsonb_agg(authz.destination_json(d.id) order by (d.retired_at is not null), lower(d.label), d.id)
      from public.company_destinations d where d.legal_entity_id = p_entity_id), '[]'::jsonb));
end;
$$;

-- Selectable versions for a new receipt on this deal: approved current,
-- not retired, same entity and the same synthetic flag as the deal.
create function public.company_destination_options(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'versionId', v.id, 'destinationId', d.id, 'kind', d.kind, 'label', d.label, 'versionNo', v.version_no,
      'bankName', v.bank_name, 'accountMasked', authz.destination_mask_account(v.account_number),
      'payeeName', v.payee_name, 'upiMasked', authz.destination_mask_upi(v.upi_id))
      order by d.kind, lower(d.label), d.id)
    from public.company_destinations d
    join public.company_destination_versions v on v.id = d.current_version_id
    where d.legal_entity_id = v_deal.legal_entity_id and d.retired_at is null and v.status = 'approved'
      and d.is_synthetic = v_deal.is_synthetic), '[]'::jsonb);
end;
$$;

-- Full values of one version, only after the audit row is written. A missing
-- version and an unauthorized caller get the same refusal.
create function public.company_destination_version_detail(p_version_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.company_destination_versions%rowtype;
begin
  perform authz.finance_require_accounts(authz.destination_entity_of_version(p_version_id), null);
  select * into v from public.company_destination_versions x where x.id = p_version_id;
  perform authz.write_audit('finance.destination_viewed', v.legal_entity_id, null, 'company_destination', v.destination_id,
    null, jsonb_build_object('versionId', v.id, 'versionNo', v.version_no));
  return jsonb_build_object('versionId', v.id, 'versionNo', v.version_no, 'holderName', v.holder_name,
    'bankName', v.bank_name, 'accountNumber', v.account_number, 'ifsc', v.ifsc, 'payeeName', v.payee_name, 'upiId', v.upi_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Receipt binding (replaces receipt_record; every other rule is unchanged)
-- ---------------------------------------------------------------------------

create or replace function public.receipt_record(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_entity uuid;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_t timestamptz := now();
  v_today date := authz.finance_today();
  v_policy public.finance_policy_versions%rowtype;
  v_mode text;
  v_amount_text text;
  v_amount bigint;
  v_received date;
  v_branch uuid;
  v_collector uuid;
  v_payer text;
  v_pan text;
  v_mobile text;
  v_reference text;
  v_norm text;
  v_micr text;
  v_cheque_no text;
  v_cheque_date date;
  v_payee jsonb;
  v_booking uuid;
  v_corrects uuid;
  v_note text;
  v_orig public.customer_receipts%rowtype;
  v_id uuid := gen_random_uuid();
  v_keys text[] := '{}';
  v_hash bigint;
  v_sum bigint;
  v_fy text;
  v_seq integer;
  v_no text;
  v_dest_version uuid;
  v_dv public.company_destination_versions%rowtype;
  v_dest public.company_destinations%rowtype;
  v_snapshot jsonb;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  v_entity := v_deal.legal_entity_id;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_policy(v_entity, false);   -- lock 1
  perform authz.finance_lock_deal(v_deal.id);           -- lock 2
  v_result := authz.finance_replay(v_entity, p_request_id, 'receipt_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- Stage 0 (20261107000300, kept here): a Deal removed by the Bitrix sync takes
  -- no new receipt (an exact retry of a receipt recorded before the removal
  -- replays above). The KEY SHARE lock waits for an in-flight removal, which
  -- holds FOR UPDATE on the Deal.
  perform 1 from public.deals d where d.id = v_deal.id for key share;
  if exists (select 1 from public.deals d where d.id = v_deal.id and d.removed_at is not null) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['mode', 'amountPaise', 'receivedOn', 'branchId', 'collectorUserId', 'payerName', 'payerPan',
                          'payerMobile', 'reference', 'micrCode', 'chequeNumber', 'chequeDate', 'accountPayee',
                          'bookingVersionId', 'correctsReceiptId', 'note', 'destinationVersionId']) <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;
  v_mode := authz.finance_field(p_fields, 'mode');
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cash', 'cheque') then
    perform authz.finance_invalid();
  end if;
  if not authz.finance_mode_allowed(v_entity, v_mode) then
    raise exception 'mode_not_live' using errcode = '55000';
  end if;

  -- The policy is read once: this version and v_t for every check.
  v_policy := authz.finance_policy_at(v_entity, v_t);
  if v_policy.id is null then
    raise exception 'not_configured' using errcode = '55000';
  end if;

  v_amount_text := authz.finance_field(p_fields, 'amountPaise');
  if v_amount_text is null or v_amount_text !~ '^[1-9][0-9]{0,17}$' then
    perform authz.finance_invalid();
  end if;
  v_amount := v_amount_text::bigint;
  if v_amount > v_policy.receipt_max_paise then
    perform authz.finance_invalid();
  end if;

  v_received := authz.finance_date(authz.finance_field(p_fields, 'receivedOn'));
  if v_received is null or v_received not between v_today - 30 and v_today then
    perform authz.finance_invalid();
  end if;

  v_branch := authz.finance_uuid(authz.finance_field(p_fields, 'branchId'));
  if v_branch is null or not exists (
       select 1 from public.branches b where b.id = v_branch and b.legal_entity_id = v_entity and b.status = 'enabled') then
    perform authz.finance_invalid();
  end if;

  v_collector := authz.finance_uuid(authz.finance_field(p_fields, 'collectorUserId'));
  if v_mode = 'cash' then
    if v_collector is null or not exists (
         select 1 from public.staff_profiles p
         join public.memberships m on m.user_id = p.user_id
         where p.user_id = v_collector and p.status = 'active' and m.status = 'active' and m.legal_entity_id = v_entity) then
      perform authz.finance_invalid();
    end if;
  elsif v_collector is not null then
    perform authz.finance_invalid();
  end if;

  v_payer := authz.finance_text(authz.finance_field(p_fields, 'payerName'), 1, 200, false);
  v_pan := upper(authz.finance_text(authz.finance_field(p_fields, 'payerPan'), 1, 10, false));
  v_mobile := authz.finance_mobile(authz.finance_field(p_fields, 'payerMobile'));
  if v_payer is null or (v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$') or (v_pan is null and v_mobile is null) then
    perform authz.finance_invalid();
  end if;

  v_reference := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 40, false);
  if v_mode in ('bank_transfer', 'upi') then
    if v_reference is null or v_reference !~ '^[A-Za-z0-9/-]{6,40}$' then
      perform authz.finance_invalid();
    end if;
    v_norm := upper(replace(replace(v_reference, ' ', ''), '-', ''));
  elsif v_reference is not null then
    perform authz.finance_invalid();
  end if;

  v_micr := authz.finance_text(authz.finance_field(p_fields, 'micrCode'), 1, 9, false);
  v_cheque_no := authz.finance_text(authz.finance_field(p_fields, 'chequeNumber'), 1, 6, false);
  v_cheque_date := authz.finance_date(authz.finance_field(p_fields, 'chequeDate'));
  v_payee := p_fields -> 'accountPayee';
  if v_payee is not null and jsonb_typeof(v_payee) = 'null' then
    v_payee := null;
  end if;
  if v_mode = 'cheque' then
    if v_micr is null or v_micr !~ '^[0-9]{9}$' or v_cheque_no is null or v_cheque_no !~ '^[0-9]{6}$'
       or v_cheque_date is null or v_cheque_date not between v_today - 90 and v_today + 90
       or v_payee is distinct from 'true'::jsonb then
      perform authz.finance_invalid();
    end if;
  elsif v_micr is not null or v_cheque_no is not null or v_cheque_date is not null or v_payee is not null then
    perform authz.finance_invalid();
  end if;

  v_booking := authz.finance_uuid(authz.finance_field(p_fields, 'bookingVersionId'));
  if v_booking is not null and not exists (
       select 1 from public.booking_versions v where v.id = v_booking and v.deal_id = v_deal.id and v.status = 'confirmed') then
    perform authz.finance_invalid();
  end if;
  v_corrects := authz.finance_uuid(authz.finance_field(p_fields, 'correctsReceiptId'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);

  -- Lock 3: the receipt being corrected. Its link is set first so the
  -- correction may reuse the genuine reference and the caps exclude it.
  if v_corrects is not null then
    select * into v_orig from public.customer_receipts r where r.id = v_corrects for update;
    if v_orig.id is null or v_orig.deal_id <> v_deal.id or v_orig.mode <> v_mode then
      perform authz.finance_invalid();
    end if;
    if v_orig.corrected_by_receipt_id is not null
       or not ((v_orig.status = 'rejected' and v_orig.rejection_kind = 'data_error')
               or (v_orig.status = 'reversed' and v_orig.reversal_kind = 'data_error')) then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    update public.customer_receipts r set corrected_by_receipt_id = v_id, updated_at = now() where r.id = v_orig.id;
  end if;

  -- Lock 4 (Stage 2): the company destination of a bank-transfer or UPI
  -- receipt, read under a share lock so retirement or replacement cannot
  -- interleave. A correction selects the current version too; it never
  -- inherits the original receipt's version. A mismatch is refused, never
  -- replaced by another version.
  v_dest_version := authz.finance_uuid(authz.finance_field(p_fields, 'destinationVersionId'));
  if v_mode in ('bank_transfer', 'upi') then
    if v_dest_version is null then
      perform authz.finance_invalid();
    end if;
    select * into v_dv from public.company_destination_versions dv
    where dv.id = v_dest_version and dv.legal_entity_id = v_entity;
    if v_dv.id is not null then
      select * into v_dest from public.company_destinations d where d.id = v_dv.destination_id for share;
    end if;
    if v_dv.id is null or v_dest.retired_at is not null or v_dest.current_version_id is distinct from v_dv.id
       or v_dv.status <> 'approved'
       or v_dest.kind <> (case v_mode when 'bank_transfer' then 'bank' else 'upi' end)
       or v_dest.is_synthetic is distinct from v_deal.is_synthetic then
      raise exception 'destination_changed' using errcode = '55000';
    end if;
    v_snapshot := jsonb_build_object('destinationId', v_dest.id, 'versionId', v_dv.id, 'versionNo', v_dv.version_no,
      'kind', v_dest.kind, 'label', v_dest.label, 'holderName', v_dv.holder_name, 'bankName', v_dv.bank_name,
      'accountNumber', v_dv.account_number, 'ifsc', v_dv.ifsc, 'payeeName', v_dv.payee_name, 'upiId', v_dv.upi_id);
  elsif v_dest_version is not null then
    perform authz.finance_invalid();
  end if;

  -- Lock 5: cash caps (contract 9.2). Counted cash: recorded, verified,
  -- reversed or rejected, except not_received outcomes and receipts
  -- superseded by a correction (a correction can never be not_received, so
  -- the end of a correction chain always counts and the cash counts once).
  if v_mode = 'cash' then
    if v_pan is not null then
      v_keys := v_keys || ('cash-payer|' || v_entity::text || '|pan:' || v_pan || '|' || to_char(v_received, 'YYYY-MM-DD'));
    end if;
    if v_mobile is not null then
      v_keys := v_keys || ('cash-payer|' || v_entity::text || '|mobile:' || v_mobile || '|' || to_char(v_received, 'YYYY-MM-DD'));
    end if;
    v_keys := v_keys || ('cash-trip|' || v_entity::text || '|' || v_deal.id::text);
    for v_hash in select distinct hashtextextended(k, 0) from unnest(v_keys) as k order by 1 loop
      perform pg_advisory_xact_lock(v_hash);
    end loop;

    if v_pan is not null then
      select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
      where r.legal_entity_id = v_entity and r.mode = 'cash' and r.received_on = v_received and r.payer_pan = v_pan
        and r.status in ('recorded', 'verified', 'reversed', 'rejected')
        and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
        and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
        and r.corrected_by_receipt_id is null;
      if v_sum + v_amount > v_policy.cash_payer_day_cap_paise then
        raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'payer_day';
      end if;
    end if;
    if v_mobile is not null then
      select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
      where r.legal_entity_id = v_entity and r.mode = 'cash' and r.received_on = v_received and r.payer_mobile = v_mobile
        and r.status in ('recorded', 'verified', 'reversed', 'rejected')
        and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
        and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
        and r.corrected_by_receipt_id is null;
      if v_sum + v_amount > v_policy.cash_payer_day_cap_paise then
        raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'payer_day';
      end if;
    end if;
    select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
    where r.deal_id = v_deal.id and r.mode = 'cash'
      and r.status in ('recorded', 'verified', 'reversed', 'rejected')
      and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
      and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
      and r.corrected_by_receipt_id is null;
    if v_sum + v_amount > v_policy.cash_trip_cap_paise then
      raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'trip';
    end if;
  end if;

  -- Duplicate references (the unique indexes also refuse concurrent races).
  if v_mode in ('bank_transfer', 'upi') and exists (
       select 1 from public.customer_receipts r
       where r.legal_entity_id = v_entity and r.mode in ('bank_transfer', 'upi') and r.reference_norm = v_norm
         and r.corrected_by_receipt_id is null) then
    raise exception 'duplicate_reference' using errcode = '23505';
  end if;
  if v_mode = 'cheque' and exists (
       select 1 from public.customer_receipts r
       where r.legal_entity_id = v_entity and r.mode = 'cheque' and r.micr_code = v_micr and r.cheque_number = v_cheque_no
         and r.corrected_by_receipt_id is null) then
    raise exception 'duplicate_reference' using errcode = '23505';
  end if;

  -- Lock 6: the receipt counter of the recording date's fiscal year (IST).
  v_fy := authz.finance_fiscal_year(v_today);
  insert into public.finance_receipt_counters (legal_entity_id, fiscal_year) values (v_entity, v_fy) on conflict do nothing;
  update public.finance_receipt_counters c set last_no = c.last_no + 1
  where c.legal_entity_id = v_entity and c.fiscal_year = v_fy
  returning c.last_no into v_seq;
  v_no := 'R-' || v_fy || '-' || lpad(v_seq::text, 6, '0');

  begin
    insert into public.customer_receipts (id, legal_entity_id, deal_id, branch_id, receipt_no, fiscal_year, mode, status,
      amount_paise, received_on, collector_user_id, payer_name, payer_pan, payer_mobile, reference, reference_norm,
      micr_code, cheque_number, cheque_date, account_payee, booking_version_id, corrects_receipt_id, note,
      policy_version_id, request_id, recorded_by, recorded_at, destination_version_id, destination_snapshot)
    values (v_id, v_entity, v_deal.id, v_branch, v_no, v_fy, v_mode, 'recorded',
      v_amount, v_received, v_collector, v_payer, v_pan, v_mobile, v_reference, v_norm,
      v_micr, v_cheque_no, v_cheque_date, case when v_mode = 'cheque' then true end, v_booking, v_corrects, v_note,
      v_policy.id, p_request_id, (select auth.uid()), v_t, v_dv.id, v_snapshot);
  exception
    when unique_violation then
      raise exception 'duplicate_reference' using errcode = '23505';
    -- Stage 2: the row now carries a destination snapshot; never let a
    -- constraint error echo it ("Failing row contains ...").
    when check_violation or not_null_violation or foreign_key_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'receiptNo', v_no, 'status', 'recorded');
  perform authz.finance_remember(v_entity, p_request_id, 'receipt_record', v_payload, v_result);
  perform authz.write_audit('finance.receipt_recorded', v_entity, v_branch, 'customer_receipt', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'receiptNo', v_no, 'mode', v_mode, 'policyVersionNo', v_policy.version_no,
      'correctsReceiptId', v_corrects, 'destinationVersionId', v_dv.id));
  return v_result;
end;
$$;


create or replace function authz.finance_receipt_json(p_receipt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'receiptId', r.id,
    'receiptNo', r.receipt_no,
    'mode', r.mode,
    'status', r.status,
    'amountPaise', r.amount_paise::text,
    'receivedOn', to_char(r.received_on, 'YYYY-MM-DD'),
    'branchName', b.name,
    'collectorName', authz.finance_name(r.collector_user_id),
    'payerName', r.payer_name,
    'payerPanMasked', case when r.payer_pan is null then null else 'XXXXX' || substr(r.payer_pan, 6, 4) || 'X' end,
    'payerMobileMasked', case when r.payer_mobile is null then null else 'XXXXXX' || right(r.payer_mobile, 4) end,
    'reference', r.reference,
    'chequeNumber', r.cheque_number,
    'micrCode', r.micr_code,
    'chequeDate', to_char(r.cheque_date, 'YYYY-MM-DD'),
    'rejectionKind', r.rejection_kind,
    'reversalKind', r.reversal_kind,
    'reason', r.reason,
    'correctsReceiptNo', (select o.receipt_no from public.customer_receipts o where o.id = r.corrects_receipt_id),
    'correctedByReceiptNo', (select o.receipt_no from public.customer_receipts o where o.id = r.corrected_by_receipt_id),
    'recordedByName', authz.finance_name(r.recorded_by),
    'recordedAt', r.recorded_at,
    'verifiedByName', authz.finance_name(r.verified_by),
    'verifiedAt', r.verified_at,
    'outcomeDate', to_char(r.outcome_date, 'YYYY-MM-DD'),
    'policyVersionNo', (select v.version_no from public.finance_policy_versions v where v.id = r.policy_version_id),
    -- Stage 2: masked snapshot (label, kind, bank name, last four), unmapped
    -- for older bank-transfer/UPI receipts, null for cash and cheque.
    'destination', case
      when r.destination_snapshot is not null then jsonb_build_object(
        'unmapped', false,
        'label', r.destination_snapshot ->> 'label',
        'kind', r.destination_snapshot ->> 'kind',
        'versionNo', (r.destination_snapshot ->> 'versionNo')::integer,
        'bankName', r.destination_snapshot ->> 'bankName',
        'accountMasked', authz.destination_mask_account(r.destination_snapshot ->> 'accountNumber'),
        'upiMasked', authz.destination_mask_upi(r.destination_snapshot ->> 'upiId'))
      when r.mode in ('bank_transfer', 'upi') then jsonb_build_object('unmapped', true)
      else null end,
    'evidence', authz.finance_evidence_list_json(r.id, null),
    'actions', authz.finance_receipt_actions(r.id))
  from public.customer_receipts r
  join public.branches b on b.id = r.branch_id
  where r.id = p_receipt
$$;


-- ---------------------------------------------------------------------------
-- Row level security and grants (same pattern as the finance tables)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['company_destinations', 'company_destination_versions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function
  authz.company_destinations_guard(), authz.company_destination_versions_guard(),
  authz.customer_receipts_destination_required(), authz.destination_mask_account(text), authz.destination_mask_upi(text),
  authz.destination_values(text, jsonb), authz.destination_version_json(uuid), authz.destination_json(uuid),
  authz.destination_entity_of_version(uuid), authz.destination_lock_for_decision(uuid)
from public, anon, authenticated;

revoke all on function
  public.company_destination_submit(uuid, uuid, jsonb, integer, uuid),
  public.company_destination_approve(uuid, integer, uuid),
  public.company_destination_return(uuid, integer, text, uuid),
  public.company_destination_retire(uuid, integer, text, uuid),
  public.company_destinations_list(uuid),
  public.company_destination_options(uuid),
  public.company_destination_version_detail(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.company_destination_submit(uuid, uuid, jsonb, integer, uuid),
  public.company_destination_approve(uuid, integer, uuid),
  public.company_destination_return(uuid, integer, text, uuid),
  public.company_destination_retire(uuid, integer, text, uuid),
  public.company_destinations_list(uuid),
  public.company_destination_options(uuid),
  public.company_destination_version_detail(uuid)
to authenticated;

commit;
