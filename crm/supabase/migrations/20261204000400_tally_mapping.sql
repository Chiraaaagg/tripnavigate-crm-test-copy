-- TripNavigate CRM - Accounts phase 2, Track D (1 of 4): Tally ledger mapping.
-- Contract: accounts-phase2-2026-11-11/contract.md section 8.1, LD19, LD20
-- (frozen 11 Nov 2026). Owner rule: the CRM never posts to Tally; this table
-- only fills columns of the CSV evidence export.
--
-- What this file adds:
--   1. public.tally_ledger_mappings: one row per (entity, CRM row kind,
--      service class) -> Tally debit ledger, credit ledger and voucher type.
--      Pre-filled for every entity (and for every entity created later, by
--      trigger) with the names read from the Tally structure summary of
--      11 November 2026 (tally-structure.md: ledger and voucher type names
--      only, never amounts or party names). Bank, cash, customer advance,
--      purchase and expense ledger names stay NULL for Accounts to fill
--      (LD20); the CSV then says "Mapping missing".
--      Rows: customer invoice / credit note / supplier invoice / supplier
--      credit note per service class; every other row kind once ('any').
--      The export looks up (kind, class) and falls back to (kind, 'any').
--   2. public.tally_ledger_mapping_changes: append-only history (one row
--      per changed field, old and new value, who, when, reason).
--   3. D1 public.tally_mapping_list(p_entity)  Accounts of the entity; else null.
--      Addition (screen 11 "history"): public.tally_mapping_history(p_mapping_id)
--         {mappingId, items [{field, oldValue, newValue, changedAt,
--         changedByName, reason}]} (last 100), same reader rule.
--      D2 public.tally_mapping_set(p_mapping_id, p_expected_row_version,
--         p_fields {debitLedger?, creditLedger?, voucherType?}, p_reason,
--         p_request_id)  Accounts of the entity; a present key sets the
--         value (null or blank clears it); reason 10..500; history rows;
--         audit accounts.tally_mapping_changed {mappingId, fields}.
--   The mapping is NOT part of the Tally source hash (LD19): changing it
--   never flags "changed since export"; the next export uses the new names.
--
-- Refusal tokens: not_authorized (42501), not_found (P0002), version_changed
-- (40001), request_conflict (40001), invalid_input (22023, hint = field).
-- Rollback (forward-only): a new migration revoking execute on D1/D2. Never
-- delete mapping or history rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

-- Ledger / voucher name rule: 1..max characters, no control characters, no
-- leading = + - @ (the value is written into a CSV cell).
create function authz.tally_name_ok(p text, p_max integer) returns boolean
language sql immutable set search_path = '' as $$
  select p is null or (length(p) between 1 and p_max and p !~ '[[:cntrl:]]' and p !~ '^[=+@-]' and p = btrim(p))
$$;

create table public.tally_ledger_mappings (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  row_kind text not null check (row_kind in ('receipt_bank', 'receipt_cash', 'receipt_reversal', 'cash_deposit',
    'customer_refund_bank', 'customer_refund_cash', 'supplier_payment', 'supplier_invoice', 'supplier_credit_note',
    'expense', 'customer_advance_invoice', 'customer_invoice', 'customer_credit_note', 'supplier_refund',
    'tally_gst_invoice')),
  service_class text not null check (service_class in ('any', 'hotel', 'transfer', 'activity', 'flight_domestic',
    'flight_international', 'package_domestic', 'package_overseas', 'visa', 'passport', 'misc')),
  debit_ledger text check (authz.tally_name_ok(debit_ledger, 100)),
  credit_ledger text check (authz.tally_name_ok(credit_ledger, 100)),
  voucher_type text check (authz.tally_name_ok(voucher_type, 60)),
  row_version integer not null default 1 check (row_version >= 1),
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (legal_entity_id, row_kind, service_class),
  unique (legal_entity_id, id)
);
create index tally_ledger_mappings_updated_by_idx on public.tally_ledger_mappings (updated_by) where updated_by is not null;
comment on table public.tally_ledger_mappings is
  'Accounts phase 2 (8.1): CRM row kind x service class -> Tally ledger names and voucher type, used only to fill the CSV evidence export (never posted to Tally). Pre-filled from tally-structure.md names; NULL = for Accounts to fill (LD20). Changed only through public.tally_mapping_set. Not part of the Tally source hash (LD19). No table grant.';

create table public.tally_ledger_mapping_changes (
  id bigint generated always as identity primary key,
  legal_entity_id uuid not null,
  mapping_id uuid not null,
  field text not null check (field in ('debit_ledger', 'credit_ledger', 'voucher_type')),
  old_value text,
  new_value text,
  changed_by uuid not null references public.staff_profiles (user_id),
  changed_at timestamptz not null default now(),
  reason text not null check (length(reason) between 10 and 500),
  foreign key (legal_entity_id, mapping_id) references public.tally_ledger_mappings (legal_entity_id, id)
);
create index tally_ledger_mapping_changes_mapping_idx on public.tally_ledger_mapping_changes (legal_entity_id, mapping_id, changed_at desc);
create index tally_ledger_mapping_changes_changed_by_idx on public.tally_ledger_mapping_changes (changed_by);
comment on table public.tally_ledger_mapping_changes is
  'Accounts phase 2 (8.1): history of Tally mapping edits (one row per changed field). Append-only. No table grant.';

create function authz.tally_ledger_mappings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Tally mapping rows cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id
     or new.row_kind is distinct from old.row_kind or new.service_class is distinct from old.service_class
     or new.created_at is distinct from old.created_at or new.row_version <> old.row_version + 1 then
    raise exception 'Tally mapping identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tally_ledger_mappings_a_guard before update or delete on public.tally_ledger_mappings
  for each row execute function authz.tally_ledger_mappings_guard();
create trigger tally_ledger_mapping_changes_append_only before update or delete on public.tally_ledger_mapping_changes
  for each row execute function authz.finance_append_only();

alter table public.tally_ledger_mappings enable row level security;
alter table public.tally_ledger_mapping_changes enable row level security;
create policy require_valid_session on public.tally_ledger_mappings as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.tally_ledger_mapping_changes as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.tally_ledger_mappings, public.tally_ledger_mapping_changes
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Pre-fill (tally-structure.md names only)
-- ===========================================================================

-- The pre-filled rows: (row kind, service class, debit, credit, voucher).
create function authz.tally_mapping_defaults()
returns table (row_kind text, service_class text, debit_ledger text, credit_ledger text, voucher_type text)
language sql immutable set search_path = '' as $$
  values
    -- Customer invoices: sales ledger per service and the service's sales voucher type.
    ('customer_invoice', 'hotel', null, 'Hotel Booking', 'Hotel Invoice'),
    ('customer_invoice', 'flight_domestic', null, 'Domestic Air Ticket', 'Domestic Tkt'),
    ('customer_invoice', 'flight_international', null, 'International Air Ticket', 'International Tkt'),
    ('customer_invoice', 'package_domestic', null, 'Domestic Package', 'Package Invoice'),
    ('customer_invoice', 'package_overseas', null, 'Overseas Package', 'Package Invoice'),
    ('customer_invoice', 'visa', null, 'Visa', 'Visa Inv'),
    ('customer_invoice', 'passport', null, 'Passport', 'Passport Inv'),
    ('customer_invoice', 'transfer', null, 'Transport', 'Transport Inv'),
    ('customer_invoice', 'activity', null, 'Excursion', 'Misc Inv'),
    ('customer_invoice', 'misc', null, 'Miscellaneous', 'Misc Inv'),
    -- Customer credit notes: the same sales ledger (debited) and the credit-note voucher type.
    ('customer_credit_note', 'hotel', 'Hotel Booking', null, 'Hotel Cn'),
    ('customer_credit_note', 'flight_domestic', 'Domestic Air Ticket', null, 'Domestic CN'),
    ('customer_credit_note', 'flight_international', 'International Air Ticket', null, 'Int. Cn'),
    ('customer_credit_note', 'package_domestic', 'Domestic Package', null, 'Package Cn'),
    ('customer_credit_note', 'package_overseas', 'Overseas Package', null, 'Package Cn'),
    ('customer_credit_note', 'visa', 'Visa', null, 'VisaCn'),
    ('customer_credit_note', 'passport', 'Passport', null, 'Miscellaneous CN'),
    ('customer_credit_note', 'transfer', 'Transport', null, 'Miscellaneous CN'),
    ('customer_credit_note', 'activity', 'Excursion', null, 'Miscellaneous CN'),
    ('customer_credit_note', 'misc', 'Miscellaneous', null, 'Miscellaneous CN'),
    -- Supplier bills per service: purchase ledgers are for Accounts to fill (LD20).
    ('supplier_invoice', 'hotel', null, null, 'Purchase'),
    ('supplier_invoice', 'flight_domestic', null, null, 'Purchase'),
    ('supplier_invoice', 'flight_international', null, null, 'Purchase'),
    ('supplier_invoice', 'package_domestic', null, null, 'Purchase'),
    ('supplier_invoice', 'package_overseas', null, null, 'Purchase'),
    ('supplier_invoice', 'visa', null, null, 'Purchase'),
    ('supplier_invoice', 'passport', null, null, 'Purchase'),
    ('supplier_invoice', 'transfer', null, null, 'Purchase'),
    ('supplier_invoice', 'activity', null, null, 'Purchase'),
    ('supplier_invoice', 'misc', null, null, 'Purchase'),
    ('supplier_credit_note', 'hotel', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'flight_domestic', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'flight_international', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'package_domestic', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'package_overseas', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'visa', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'passport', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'transfer', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'activity', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'misc', null, null, 'Debit Note M'),
    -- One row each (voucher types only; bank, cash and customer-advance ledgers for Accounts, LD20).
    ('receipt_bank', 'any', null, null, 'Receipt'),
    ('receipt_cash', 'any', null, null, 'Receipt'),
    ('receipt_reversal', 'any', null, null, 'Journal'),
    ('cash_deposit', 'any', null, null, 'Contra'),
    ('customer_refund_bank', 'any', null, null, 'Payment'),
    ('customer_refund_cash', 'any', null, null, 'Payment'),
    ('supplier_payment', 'any', null, null, 'Payment'),
    ('expense', 'any', null, null, 'Payment'),
    ('customer_advance_invoice', 'any', null, null, 'Receipt'),
    ('supplier_refund', 'any', null, null, 'Receipt'),
    ('tally_gst_invoice', 'any', null, null, null)
$$;

create function authz.tally_mapping_seed(p_entity uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.tally_ledger_mappings (legal_entity_id, row_kind, service_class, debit_ledger, credit_ledger, voucher_type)
  select p_entity, d.row_kind, d.service_class, d.debit_ledger, d.credit_ledger, d.voucher_type
  from authz.tally_mapping_defaults() d
  order by d.row_kind, d.service_class
  on conflict (legal_entity_id, row_kind, service_class) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function authz.tally_mapping_seed_entity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.tally_mapping_seed(new.id);
  return null;
end;
$$;
create trigger legal_entities_tally_mapping_seed after insert on public.legal_entities
  for each row execute function authz.tally_mapping_seed_entity();

select authz.tally_mapping_seed(e.id) from public.legal_entities e order by e.id;

-- The mapping row the export uses: exact (kind, class), else (kind, 'any').
create function authz.tally_mapping_for(p_entity uuid, p_row_kind text, p_service text)
returns public.tally_ledger_mappings
language sql stable security definer set search_path = '' as $$
  select m.* from public.tally_ledger_mappings m
  where m.legal_entity_id = p_entity and m.row_kind = p_row_kind and m.service_class in (coalesce(p_service, 'any'), 'any')
  order by (m.service_class = 'any'), m.id
  limit 1
$$;

-- "Mapping missing": no voucher type, or neither ledger named (the other
-- side is the party ledger, given in the Party column).
create function authz.tally_mapping_missing(p_debit text, p_credit text, p_voucher text) returns boolean
language sql immutable set search_path = '' as $$
  select p_voucher is null or (p_debit is null and p_credit is null)
$$;

-- ===========================================================================
-- 3. D1 / D2
-- ===========================================================================

create function public.tally_mapping_list(p_entity uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_entity is null or not coalesce(authz.session_ok(), false) or not (p_entity = any(authz.acct_a_entities())) then
    return null;
  end if;
  return jsonb_build_object(
    'entityId', p_entity,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
          'mappingId', m.id, 'rowKind', m.row_kind, 'serviceClass', m.service_class,
          'debitLedger', m.debit_ledger, 'creditLedger', m.credit_ledger, 'voucherType', m.voucher_type,
          'rowVersion', m.row_version, 'updatedAt', m.updated_at, 'updatedByName', p.display_name)
        order by m.row_kind, (m.service_class <> 'any'), m.service_class)
      from public.tally_ledger_mappings m
      left join public.staff_profiles p on p.user_id = m.updated_by
      where m.legal_entity_id = p_entity), '[]'::jsonb),
    'missingCount', (select count(*)::int from public.tally_ledger_mappings m
                     where m.legal_entity_id = p_entity
                       and authz.tally_mapping_missing(m.debit_ledger, m.credit_ledger, m.voucher_type)));
end;
$$;

-- One name field of p_fields (the caller checks presence): null or blank -> null (clear).
create function authz.tally_mapping_field(p_fields jsonb, p_key text, p_max integer) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_fields -> p_key;
  t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    raise exception 'invalid_input' using errcode = '22023', hint = p_key;
  end if;
  t := btrim(v #>> '{}');
  if t = '' then
    return null;
  end if;
  if not authz.tally_name_ok(t, p_max) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_key;
  end if;
  return t;
end;
$$;

create function public.tally_mapping_set(p_mapping_id uuid, p_expected_row_version integer, p_fields jsonb, p_reason text,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.tally_ledger_mappings%rowtype;
  v_payload jsonb := jsonb_build_object('mappingId', p_mapping_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_debit text;
  v_credit text;
  v_voucher text;
  v_changed text[] := array[]::text[];
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_mapping_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'mappingId';
  end if;
  select * into v from public.tally_ledger_mappings m where m.id = p_mapping_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v.legal_entity_id, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'tally_mapping_set', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v from public.tally_ledger_mappings m where m.id = p_mapping_id for update;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb
     or (p_fields - array['debitLedger', 'creditLedger', 'voucherType']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_debit := case when p_fields ? 'debitLedger' then authz.tally_mapping_field(p_fields, 'debitLedger', 100) else v.debit_ledger end;
  v_credit := case when p_fields ? 'creditLedger' then authz.tally_mapping_field(p_fields, 'creditLedger', 100) else v.credit_ledger end;
  v_voucher := case when p_fields ? 'voucherType' then authz.tally_mapping_field(p_fields, 'voucherType', 60) else v.voucher_type end;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  if v_debit is distinct from v.debit_ledger then
    v_changed := v_changed || 'debitLedger'::text;
    insert into public.tally_ledger_mapping_changes (legal_entity_id, mapping_id, field, old_value, new_value, changed_by, reason)
    values (v.legal_entity_id, v.id, 'debit_ledger', v.debit_ledger, v_debit, v_uid, v_reason);
  end if;
  if v_credit is distinct from v.credit_ledger then
    v_changed := v_changed || 'creditLedger'::text;
    insert into public.tally_ledger_mapping_changes (legal_entity_id, mapping_id, field, old_value, new_value, changed_by, reason)
    values (v.legal_entity_id, v.id, 'credit_ledger', v.credit_ledger, v_credit, v_uid, v_reason);
  end if;
  if v_voucher is distinct from v.voucher_type then
    v_changed := v_changed || 'voucherType'::text;
    insert into public.tally_ledger_mapping_changes (legal_entity_id, mapping_id, field, old_value, new_value, changed_by, reason)
    values (v.legal_entity_id, v.id, 'voucher_type', v.voucher_type, v_voucher, v_uid, v_reason);
  end if;

  if cardinality(v_changed) = 0 then
    v_result := jsonb_build_object('outcome', 'existing', 'mappingId', v.id, 'rowVersion', v.row_version, 'fields', '[]'::jsonb);
  else
    update public.tally_ledger_mappings m
    set debit_ledger = v_debit, credit_ledger = v_credit, voucher_type = v_voucher,
        row_version = m.row_version + 1, updated_by = v_uid, updated_at = now()
    where m.id = v.id
    returning * into v;
    perform authz.write_audit('accounts.tally_mapping_changed', v.legal_entity_id, null, 'tally_mapping', v.id, v_reason,
      jsonb_build_object('mappingId', v.id, 'fields', to_jsonb(v_changed), 'rowVersion', v.row_version));
    v_result := jsonb_build_object('outcome', 'updated', 'mappingId', v.id, 'rowVersion', v.row_version,
      'fields', to_jsonb(v_changed));
  end if;
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'tally_mapping_set', v_payload, v_result);
end;
$$;

-- History of one mapping row (Accounts of the entity; newest first, last 100).
create function public.tally_mapping_history(p_mapping_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.tally_ledger_mappings%rowtype;
begin
  if p_mapping_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v from public.tally_ledger_mappings m where m.id = p_mapping_id;
  if v.id is null or not (v.legal_entity_id = any(authz.acct_a_entities())) then
    return null;
  end if;
  return jsonb_build_object('mappingId', v.id, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('field', case x.field when 'debit_ledger' then 'debitLedger'
                                                        when 'credit_ledger' then 'creditLedger' else 'voucherType' end,
        'oldValue', x.old_value, 'newValue', x.new_value, 'changedAt', x.changed_at,
        'changedByName', p.display_name, 'reason', x.reason) order by x.changed_at desc, x.id desc)
    from (select * from public.tally_ledger_mapping_changes c
          where c.legal_entity_id = v.legal_entity_id and c.mapping_id = v.id
          order by c.changed_at desc, c.id desc limit 100) x
    left join public.staff_profiles p on p.user_id = x.changed_by), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 4. Grants
-- ===========================================================================

revoke all on function authz.tally_name_ok(text, integer), authz.tally_ledger_mappings_guard(),
  authz.tally_mapping_defaults(), authz.tally_mapping_seed(uuid), authz.tally_mapping_seed_entity(),
  authz.tally_mapping_for(uuid, text, text), authz.tally_mapping_missing(text, text, text),
  authz.tally_mapping_field(jsonb, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.tally_mapping_list(uuid), public.tally_mapping_set(uuid, integer, jsonb, text, uuid),
  public.tally_mapping_history(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.tally_mapping_list(uuid), public.tally_mapping_set(uuid, integer, jsonb, text, uuid),
  public.tally_mapping_history(uuid)
  to authenticated;

commit;
