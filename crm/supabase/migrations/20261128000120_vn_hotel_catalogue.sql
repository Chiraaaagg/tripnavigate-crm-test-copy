-- TripNavigate CRM - voice-note booking form batch (24 October 2026), part 3:
-- hotel catalogue (stored, searchable, entity-scoped).
--
-- Owner table of 24 October 2026 item 5 (lead brief lead-voice-notes.md):
-- hotels are stored and searched type-ahead (no full dumps), entity-scoped,
-- with source references; filled by protected imports (20261128000140) with a
-- dry-run validation summary; never merged by name alone; a verified hotel is
-- never overwritten by an import. Shapes: Atlas notes atlas-vn-shapes.md
-- section (f).
--
-- What changes:
--   1. public.hotel_catalogue: name, city, area, address, star category (1-7),
--      source reference (unique per entity), status (active | inactive),
--      verification (not_checked | checked), last import batch. No Data API
--      access (definer reads and commands only); rows never deleted.
--   2. authz.vn_hotel_check(fields): the one field rule used by the Super
--      Admin edit and the import validation (reason codes and input keys).
--   3. public.hotel_catalogue_search(query, city, limit, offset): active staff
--      of the hotel's entity (hotel names and places only: no prices, no
--      customer data); 2+ characters; name prefix matches first, then
--      contains; active hotels only; at most 50 per page.
--   4. public.hotel_catalogue_save(entity, id, row version, fields, reason):
--      Super Admin of the entity at aal2, reason 10-500, audited
--      hotel.catalogue_saved (field names only).
--
-- Refusal tokens: 42501 not_authorized; 22023 invalid_input (hint = keys);
-- 40001 version_changed; P0002 not_found; 22023 'a reason of 10 to 500
-- characters is required'.
--
-- Fix round (Echo-A review of 24 Oct; this file had run on disposable local
-- stacks only, so it is amended in place): L5 text that would run as a
-- spreadsheet formula is refused (reason formula_text, authz.vn_formula_keys).
--
-- Rollback (forward-only): a new migration revoking execute on the two public
-- functions. Rows are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Table
-- ===========================================================================

create table public.hotel_catalogue (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  name text not null check (char_length(name) between 1 and 200 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  -- Lower-case name for prefix search (text_pattern_ops index).
  name_key text generated always as (lower(name)) stored,
  city text not null check (char_length(city) between 1 and 120 and city = btrim(city) and city !~ '[[:cntrl:]]'),
  area text check (char_length(area) between 1 and 120 and area !~ '[[:cntrl:]]'),
  address text check (char_length(address) between 1 and 300 and address !~ '[[:cntrl:]]'),
  star_category text check (star_category ~ '^[1-7]$'),
  source_ref text check (source_ref ~ '^[A-Za-z0-9._:/-]{1,80}$'),
  status text not null default 'active' check (status in ('active', 'inactive')),
  verification text not null default 'not_checked' check (verification in ('not_checked', 'checked')),
  checked_by uuid references public.staff_profiles (user_id),
  checked_at timestamptz,
  import_batch_id uuid,
  row_version integer not null default 1 check (row_version >= 1),
  created_by uuid not null references public.staff_profiles (user_id),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_catalogue_checked_pair check ((verification = 'checked') = (checked_at is not null and checked_by is not null))
);
create unique index hotel_catalogue_source_ref_key on public.hotel_catalogue (legal_entity_id, source_ref)
  where source_ref is not null;
create index hotel_catalogue_name_idx on public.hotel_catalogue (legal_entity_id, name_key text_pattern_ops);
create index hotel_catalogue_checked_by_idx on public.hotel_catalogue (checked_by) where checked_by is not null;
create index hotel_catalogue_created_by_idx on public.hotel_catalogue (created_by);
create index hotel_catalogue_updated_by_idx on public.hotel_catalogue (updated_by);
create index hotel_catalogue_import_batch_idx on public.hotel_catalogue (import_batch_id) where import_batch_id is not null;
comment on table public.hotel_catalogue is
  'Voice-note batch: hotels of one legal entity for the booking form type-ahead (names and places only: never prices or customer data). Written by public.hotel_catalogue_save (Super Admin) and the hotel import apply; read through public.hotel_catalogue_search. Matching is by source reference only, never by name. A checked hotel is never overwritten by an import. Rows are never deleted (inactive instead). No Data API access.';

create function authz.vn_no_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'rows of % are never deleted', tg_table_name using errcode = '42501';
end;
$$;
create trigger hotel_catalogue_no_delete before delete on public.hotel_catalogue
  for each row execute function authz.vn_no_delete();

alter table public.hotel_catalogue enable row level security;
create policy require_valid_session on public.hotel_catalogue as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.hotel_catalogue from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Field rule (Super Admin edit and import validation)
-- ===========================================================================

-- One cleaned text value: null for absent, JSON null or blank; ok = false for
-- a non-string, control characters or more than p_max characters.
create function authz.vn_text(p_value jsonb, p_max integer, out ok boolean, out value text)
language plpgsql immutable set search_path = '' as $$
begin
  ok := true;
  value := null;
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    ok := false;
    return;
  end if;
  value := nullif(btrim(p_value #>> '{}', E' \t\r\n'), '');
  if value is not null and (char_length(value) > p_max or value ~ '[[:cntrl:]]') then
    ok := false;
    value := null;
  end if;
end;
$$;

-- Echo-A L5: keys whose text would run as a spreadsheet formula if a list is
-- later exported (leading = + - @, tab or carriage return), unless the value
-- reads as a number or phone number (+91..., -5, 12.50).
create function authz.vn_formula_keys(p_fields jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(e.key order by e.key), '{}'::text[])
  from jsonb_each(case when jsonb_typeof(p_fields) = 'object' then p_fields else '{}'::jsonb end) e
  where jsonb_typeof(e.value) = 'string'
    and (e.value #>> '{}') ~ '^[=+@\t\r-]'
    and (e.value #>> '{}') !~ '^[+-]?[0-9][0-9 ().,/-]*$'
$$;

-- p_fields keys: name, city, area, address, starCategory, sourceRef, status,
-- verification (each a string or null). Answers {reasons: [codes], keys:
-- [input keys], values: {...cleaned; starCategory '1'..'7'; status default
-- active}}. Unknown keys: reason unknown_column, key = the key itself.
create function authz.vn_hotel_check(p_fields jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_r text[] := '{}'::text[];
  v_k text[] := '{}'::text[];
  v_t record;
  v_vals jsonb := '{}'::jsonb;
  v_star text;
  k text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    return jsonb_build_object('reasons', jsonb_build_array('not_text'), 'keys', jsonb_build_array('fields'), 'values', '{}'::jsonb);
  end if;
  for k in select jsonb_object_keys(p_fields) loop
    if k not in ('name', 'city', 'area', 'address', 'starCategory', 'sourceRef', 'status', 'verification') then
      v_r := v_r || 'unknown_column'::text;
      v_k := v_k || k;
    end if;
  end loop;
  -- Echo-A L5: formula text is refused.
  if cardinality(authz.vn_formula_keys(p_fields)) > 0 then
    v_r := v_r || 'formula_text'::text;
    v_k := v_k || authz.vn_formula_keys(p_fields);
  end if;
  select * into v_t from authz.vn_text(p_fields -> 'name', 200);
  if not v_t.ok then v_r := v_r || 'name_too_long'::text; v_k := v_k || 'name'::text;
  elsif v_t.value is null then v_r := v_r || 'name_missing'::text; v_k := v_k || 'name'::text;
  else v_vals := v_vals || jsonb_build_object('name', v_t.value); end if;
  select * into v_t from authz.vn_text(p_fields -> 'city', 120);
  if not v_t.ok then v_r := v_r || 'city_too_long'::text; v_k := v_k || 'city'::text;
  elsif v_t.value is null then v_r := v_r || 'city_missing'::text; v_k := v_k || 'city'::text;
  else v_vals := v_vals || jsonb_build_object('city', v_t.value); end if;
  select * into v_t from authz.vn_text(p_fields -> 'area', 120);
  if not v_t.ok then v_r := v_r || 'area_too_long'::text; v_k := v_k || 'area'::text;
  else v_vals := v_vals || jsonb_build_object('area', v_t.value); end if;
  select * into v_t from authz.vn_text(p_fields -> 'address', 300);
  if not v_t.ok then v_r := v_r || 'address_too_long'::text; v_k := v_k || 'address'::text;
  else v_vals := v_vals || jsonb_build_object('address', v_t.value); end if;
  select * into v_t from authz.vn_text(p_fields -> 'starCategory', 20);
  -- "4", "4 star", "4 Stars", "4*" -> '4'.
  v_star := case when v_t.ok and v_t.value is not null
                 then substring(lower(v_t.value) from '^([1-7])\s*(?:\*|stars?)?$') end;
  if not v_t.ok or (v_t.value is not null and v_star is null) then
    v_r := v_r || 'star_category_invalid'::text; v_k := v_k || 'starCategory'::text;
  else
    v_vals := v_vals || jsonb_build_object('starCategory', v_star);
  end if;
  select * into v_t from authz.vn_text(p_fields -> 'sourceRef', 80);
  if not v_t.ok or (v_t.value is not null and v_t.value !~ '^[A-Za-z0-9._:/-]{1,80}$') then
    v_r := v_r || 'source_ref_invalid'::text; v_k := v_k || 'sourceRef'::text;
  else
    v_vals := v_vals || jsonb_build_object('sourceRef', v_t.value);
  end if;
  select * into v_t from authz.vn_text(p_fields -> 'status', 20);
  if not v_t.ok or (v_t.value is not null and lower(v_t.value) not in ('active', 'inactive')) then
    v_r := v_r || 'status_invalid'::text; v_k := v_k || 'status'::text;
  else
    v_vals := v_vals || jsonb_build_object('status', coalesce(lower(v_t.value), 'active'));
  end if;
  select * into v_t from authz.vn_text(p_fields -> 'verification', 20);
  if not v_t.ok or (v_t.value is not null and v_t.value not in ('not_checked', 'checked')) then
    v_r := v_r || 'verification_invalid'::text; v_k := v_k || 'verification'::text;
  else
    v_vals := v_vals || jsonb_build_object('verification', v_t.value);
  end if;
  return jsonb_build_object('reasons', to_jsonb(array(select distinct x from unnest(v_r) x order by x)),
    'keys', to_jsonb(array(select distinct x from unnest(v_k) x order by x)), 'values', v_vals);
end;
$$;

-- Entities where the caller is an active member (enabled entity and branch).
create function authz.vn_member_entities() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.legal_entity_id), '{}')
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id
  join public.branches b on b.id = m.branch_id
  where m.user_id = (select auth.uid()) and m.status = 'active' and e.status = 'enabled' and b.status = 'enabled'
$$;

-- LIKE pattern text with its wildcards escaped (default escape character, backslash).
create function authz.vn_like_escape(p_text text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- ===========================================================================
-- 3. Search
-- ===========================================================================

create function public.hotel_catalogue_search(p_query text, p_city text default null, p_limit integer default 20,
  p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entities uuid[];
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_city text := nullif(lower(btrim(coalesce(p_city, ''))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 1000);
  v_rows jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_entities := authz.vn_member_entities();
  if cardinality(v_entities) = 0 then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if char_length(v_q) < 2 or char_length(v_q) > 100 then
    return jsonb_build_object('items', '[]'::jsonb, 'hasMore', false);
  end if;
  v_q := authz.vn_like_escape(v_q);
  -- One row more than the page answers hasMore.
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'city', x.city, 'area', x.area,
           'address', x.address, 'starCategory', x.star_category, 'verification', x.verification)
           order by x.prefix desc, x.name_key, x.city, x.id), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from (
    select h.*, (h.name_key like v_q || '%') as prefix
    from public.hotel_catalogue h
    where h.legal_entity_id = any (v_entities) and h.status = 'active'
      and h.name_key like '%' || v_q || '%'
      and (v_city is null or lower(h.city) = v_city)
    order by (h.name_key like v_q || '%') desc, h.name_key, h.city, h.id
    limit v_limit + 1 offset v_offset
  ) x;
  return jsonb_build_object('items', case when v_n > v_limit then v_rows - v_limit else v_rows end,
    'hasMore', v_n > v_limit);
end;
$$;

-- ===========================================================================
-- 4. Super Admin edit
-- ===========================================================================

-- p_id null = create (row version 0). p_fields: the keys of vn_hotel_check;
-- on an update an absent key keeps the stored value. verification 'checked'
-- records who and when; 'not_checked' clears it.
create function public.hotel_catalogue_save(p_legal_entity_id uuid, p_id uuid, p_expected_row_version integer,
  p_fields jsonb, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text;
  v_old public.hotel_catalogue%rowtype;
  v_merged jsonb;
  v_chk jsonb;
  v_vals jsonb;
  v_ver text;
  v_id uuid;
  v_row integer;
  v_changed text[];
begin
  if p_legal_entity_id is null or not authz.can_switch_live_settings(p_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if p_expected_row_version is null or p_expected_row_version < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_id is not null then
    select * into v_old from public.hotel_catalogue h where h.id = p_id and h.legal_entity_id = p_legal_entity_id for update;
    if v_old.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_merged := case when v_old.id is null then '{}'::jsonb else jsonb_build_object('name', v_old.name, 'city', v_old.city,
      'area', v_old.area, 'address', v_old.address, 'starCategory', v_old.star_category, 'sourceRef', v_old.source_ref,
      'status', v_old.status, 'verification', v_old.verification) end || p_fields;
  v_chk := authz.vn_hotel_check(v_merged);
  if jsonb_array_length(v_chk -> 'keys') > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select jsonb_array_elements_text(v_chk -> 'keys')), ',');
  end if;
  v_vals := v_chk -> 'values';
  v_ver := coalesce(v_vals ->> 'verification', 'not_checked');
  if v_vals ->> 'sourceRef' is not null and exists (
       select 1 from public.hotel_catalogue h
       where h.legal_entity_id = p_legal_entity_id and h.source_ref = v_vals ->> 'sourceRef'
         and h.id is distinct from v_old.id) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceRef';
  end if;

  if v_old.id is null then
    insert into public.hotel_catalogue (legal_entity_id, name, city, area, address, star_category, source_ref, status,
      verification, checked_by, checked_at, created_by, updated_by)
    values (p_legal_entity_id, v_vals ->> 'name', v_vals ->> 'city', v_vals ->> 'area', v_vals ->> 'address',
      v_vals ->> 'starCategory', v_vals ->> 'sourceRef', v_vals ->> 'status', v_ver,
      case when v_ver = 'checked' then (select auth.uid()) end, case when v_ver = 'checked' then now() end,
      (select auth.uid()), (select auth.uid()))
    returning id, row_version into v_id, v_row;
    v_changed := array['name', 'city', 'area', 'address', 'starCategory', 'sourceRef', 'status', 'verification'];
  else
    v_changed := array_remove(array[
      case when v_old.name is distinct from v_vals ->> 'name' then 'name' end,
      case when v_old.city is distinct from v_vals ->> 'city' then 'city' end,
      case when v_old.area is distinct from v_vals ->> 'area' then 'area' end,
      case when v_old.address is distinct from v_vals ->> 'address' then 'address' end,
      case when v_old.star_category is distinct from v_vals ->> 'starCategory' then 'starCategory' end,
      case when v_old.source_ref is distinct from v_vals ->> 'sourceRef' then 'sourceRef' end,
      case when v_old.status is distinct from v_vals ->> 'status' then 'status' end,
      case when v_old.verification is distinct from v_ver then 'verification' end], null);
    if cardinality(v_changed) = 0 then
      return jsonb_build_object('id', v_old.id, 'rowVersion', v_old.row_version, 'outcome', 'unchanged');
    end if;
    update public.hotel_catalogue h
    set name = v_vals ->> 'name', city = v_vals ->> 'city', area = v_vals ->> 'area', address = v_vals ->> 'address',
        star_category = v_vals ->> 'starCategory', source_ref = v_vals ->> 'sourceRef', status = v_vals ->> 'status',
        verification = v_ver,
        checked_by = case when v_ver = 'checked' then case when v_old.verification = 'checked' then v_old.checked_by
                                                          else (select auth.uid()) end end,
        checked_at = case when v_ver = 'checked' then case when v_old.verification = 'checked' then v_old.checked_at
                                                          else now() end end,
        row_version = h.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where h.id = v_old.id
    returning id, row_version into v_id, v_row;
  end if;
  perform authz.write_audit('hotel.catalogue_saved', p_legal_entity_id, null, 'hotel_catalogue', v_id, v_reason,
    jsonb_build_object('outcome', case when v_old.id is null then 'created' else 'updated' end,
      'changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return jsonb_build_object('id', v_id, 'rowVersion', v_row,
    'outcome', case when v_old.id is null then 'created' else 'updated' end);
end;
$$;

-- ===========================================================================
-- 5. Privileges
-- ===========================================================================

revoke all on function authz.vn_no_delete(), authz.vn_text(jsonb, integer), authz.vn_hotel_check(jsonb),
  authz.vn_formula_keys(jsonb),
  authz.vn_member_entities(), authz.vn_like_escape(text)
from public, anon, authenticated, service_role;
revoke all on function public.hotel_catalogue_search(text, text, integer, integer),
  public.hotel_catalogue_save(uuid, uuid, integer, jsonb, text)
from public, anon, authenticated, service_role;
grant execute on function public.hotel_catalogue_search(text, text, integer, integer),
  public.hotel_catalogue_save(uuid, uuid, integer, jsonb, text)
to authenticated;

commit;
