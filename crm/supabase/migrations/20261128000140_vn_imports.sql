-- TripNavigate CRM - voice-note booking form batch (24 October 2026), part 5:
-- protected imports of hotels and customers (bill-to parties).
--
-- Owner table of 24 October 2026 item 5 and owner answer 1 (lead brief
-- lead-voice-notes.md): the owner exports the lists from Excel as CSV; the
-- app parses the CSV (no new dependency) and stages the rows here; a dry-run
-- validation answers a summary (columns, counts, invalid rows with reasons,
-- duplicates inside the file and against stored records, proposed creates and
-- updates); apply is done only by the authorised role. Shapes: Atlas notes
-- atlas-vn-shapes.md section (h).
--
-- Rules:
--   * Matching is by source reference only (sourceRef column), never by name:
--     a row without a source reference always creates a new record; a stored
--     record with the same name (and city for hotels) is reported as a
--     possible duplicate, never merged.
--   * Two rows of one file with the same source reference are both refused
--     (duplicate_in_file).
--   * An update never overwrites a checked hotel or a checked customer
--     (skipped_checked). Imported records are never checked: new ones start
--     not_checked; an updated returned customer goes back to not_checked.
--   * Roles (recorded choice): hotels - Super Admin of the entity at aal2;
--     customers - Accounts of the entity (customer data is personal; Super
--     Admin by role reads no customer data). The same role stages, validates,
--     reads and applies.
--   * Apply re-runs the validation under table locks (writers wait; readers
--     do not) and refuses import_stale when the proposed counts changed since
--     the dry run; it is idempotent (an applied batch answers its stored
--     result). One audit row import.applied (counts, reason); per-row history
--     (outcome, target, previous values of an update) stays in import_rows.
--   * Lead ruling Q8: rows where the customer rule assumed a value carry the
--     warnings gst_status_assumed_registered / state_code_padded; the summary
--     counts them (assumedRows) and lists them (rowNotes, at most 200).
--
-- Fix round (Echo-A review of 24 Oct; this file had run on disposable local
-- stacks only, so it is amended in place):
--   M1 a customer import needs a branch unless the whole company is chosen
--      explicitly (import_batch_stage p_entity_wide; import_batches.entity_wide).
--   L3 the dry run answers proposalHash (every row's outcome, target and the
--      target's row version); apply re-runs it and refuses import_stale when
--      it differs (and when p_proposal_hash, the one the screen showed, differs).
--   L4 import_rows.data is blanked when a batch is applied or cancelled.
--   L5 formula text is refused (field rules, 20261128000120/0130).
--   L6 an update that clears a stored value is noted per row (will_clear:<key>,
--      clearRows, rowNotes).
--
-- What changes: tables public.import_batches and public.import_rows (no Data
-- API access, never deleted); authz.vn_import_evaluate; public commands
-- import_batch_stage, import_batch_validate, import_batch_apply,
-- import_batch_get, import_batch_list, import_batch_cancel.
--
-- Refusal tokens: 42501 not_authorized; 22023 invalid_input (hint),
-- import_too_large; 55000 import_not_validated, import_applied, wrong_state;
-- 40001 import_stale, version_changed, request_conflict; P0002 not_found;
-- 22023 'a reason of 10 to 500 characters is required'.
--
-- Rollback (forward-only): a new migration revoking execute on the commands.
-- Applied records stay (they are ordinary hotel / customer rows).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  kind text not null check (kind in ('hotel', 'customer')),
  branch_id uuid references public.branches (id),
  -- Echo-A M1: a customer import is for one branch unless the whole company was chosen explicitly.
  entity_wide boolean not null default false,
  request_id uuid not null,
  source_file_name text not null check (length(source_file_name) between 1 and 120 and source_file_name ~ '^[A-Za-z0-9._ -]+$'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer not null check (row_count between 1 and 5000),
  status text not null default 'staged' check (status in ('staged', 'validated', 'applied', 'cancelled')),
  summary jsonb,
  apply_result jsonb,
  apply_reason text check (char_length(apply_reason) between 10 and 500),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  validated_by uuid references public.staff_profiles (user_id),
  validated_at timestamptz,
  applied_by uuid references public.staff_profiles (user_id),
  applied_at timestamptz,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_batches_hotel_no_branch check (kind = 'customer' or (branch_id is null and not entity_wide)),
  constraint import_batches_customer_scope check (kind = 'hotel' or ((branch_id is null) = entity_wide)),
  constraint import_batches_applied check ((status = 'applied') = (applied_at is not null and applied_by is not null
                                                                    and apply_result is not null and apply_reason is not null)),
  constraint import_batches_request_unique unique (legal_entity_id, request_id)
);
create index import_batches_kind_idx on public.import_batches (legal_entity_id, kind, created_at desc);
create index import_batches_branch_idx on public.import_batches (branch_id) where branch_id is not null;
create index import_batches_uploaded_by_idx on public.import_batches (uploaded_by);
create index import_batches_validated_by_idx on public.import_batches (validated_by) where validated_by is not null;
create index import_batches_applied_by_idx on public.import_batches (applied_by) where applied_by is not null;
comment on table public.import_batches is
  'Voice-note batch: one staged CSV import of hotels or customers (rows parsed by the app), its dry-run summary and its apply result. Hotels: Super Admin; customers: Accounts. Never deleted. No Data API access.';

create table public.import_rows (
  batch_id uuid not null references public.import_batches (id),
  row_no integer not null check (row_no between 1 and 5000),
  legal_entity_id uuid not null references public.legal_entities (id),
  -- The row as staged: {key: string | null}; personal data for customers.
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  source_ref text,
  outcome text check (outcome in ('create', 'update', 'unchanged', 'skipped_checked', 'invalid', 'duplicate_in_file')),
  reasons text[] not null default '{}',
  warnings text[] not null default '{}',
  target_id uuid,
  -- Previous values of an applied update (history).
  before jsonb,
  primary key (batch_id, row_no)
);
create index import_rows_entity_idx on public.import_rows (legal_entity_id);
create index import_rows_target_idx on public.import_rows (target_id) where target_id is not null;
comment on table public.import_rows is
  'Voice-note batch: staged rows of an import batch with their validation outcome and, after apply, the record they created or updated (and its previous values). Readers follow the batch role. Never deleted. No Data API access.';

alter table public.hotel_catalogue
  add constraint hotel_catalogue_import_batch_fkey foreign key (import_batch_id) references public.import_batches (id);
alter table public.customer_parties
  add constraint customer_parties_import_batch_fkey foreign key (import_batch_id) references public.import_batches (id);

create trigger import_batches_no_delete before delete on public.import_batches
  for each row execute function authz.vn_no_delete();
create trigger import_rows_no_delete before delete on public.import_rows
  for each row execute function authz.vn_no_delete();

do $$
declare
  t text;
begin
  foreach t in array array['import_batches', 'import_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 2. Role and evaluation
-- ===========================================================================

-- Hotels: Super Admin of the entity at aal2. Customers: Accounts of the entity.
create function authz.vn_import_role(p_entity uuid, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_kind
    when 'hotel' then coalesce(authz.can_switch_live_settings(p_entity), false)
    when 'customer' then coalesce(authz.vn_party_accounts(p_entity), false)
    else false end
$$;

-- The cleaned values of the columns the file actually has (an update never
-- clears a stored value whose column is missing from the file); the three GST
-- values travel together.
create function authz.vn_import_present(p_vals jsonb, p_data jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  from jsonb_each(p_vals) e
  where p_data ? e.key
     or (e.key in ('gstStatus', 'gstin', 'gstReason') and p_data ?| array['gstStatus', 'gstin', 'gstReason'])
$$;

-- A stored hotel as import values.
create function authz.vn_hotel_fields(h public.hotel_catalogue) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('name', h.name, 'city', h.city, 'area', h.area, 'address', h.address,
    'starCategory', h.star_category, 'status', h.status)
$$;

-- Evaluates every row of a batch against the stored records (writes only
-- import_rows: outcome, reasons, warnings, target_id) and answers the
-- summary. Callers have authorized the actor and locked the batch.
create function authz.vn_import_evaluate(p_batch public.import_batches) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.import_rows%rowtype;
  v_chk jsonb;
  v_vals jsonb;
  v_reasons text[];
  v_warn text[];
  v_ref text;
  v_outcome text;
  v_target uuid;
  v_hotel public.hotel_catalogue%rowtype;
  v_party public.customer_parties%rowtype;
  v_refs jsonb := '{}'::jsonb;
  v_names jsonb := '{}'::jsonb;
  v_name_key text;
  v_same boolean;
  v_target_rv integer;   -- Echo-A L3
  v_proposal jsonb := '[]'::jsonb;
  v_present jsonb;       -- Echo-A L6
  v_stored jsonb;
begin
  -- Pass 1: source references and name keys seen in the file.
  for r in select * from public.import_rows x where x.batch_id = p_batch.id order by x.row_no loop
    v_ref := nullif(btrim(coalesce(case when jsonb_typeof(r.data -> 'sourceRef') = 'string' then r.data ->> 'sourceRef' end, '')), '');
    if v_ref is not null then
      v_refs := jsonb_set(v_refs, array[v_ref], to_jsonb(coalesce((v_refs ->> v_ref)::integer, 0) + 1));
    end if;
    v_name_key := lower(btrim(coalesce(case when jsonb_typeof(r.data -> 'name') = 'string' then r.data ->> 'name' end, '')))
      || case when p_batch.kind = 'hotel'
              then '|' || lower(btrim(coalesce(case when jsonb_typeof(r.data -> 'city') = 'string' then r.data ->> 'city' end, '')))
              else '' end;
    v_names := jsonb_set(v_names, array[v_name_key], to_jsonb(coalesce((v_names ->> v_name_key)::integer, 0) + 1));
  end loop;

  -- Pass 2: each row.
  for r in select * from public.import_rows x where x.batch_id = p_batch.id order by x.row_no loop
    v_reasons := '{}';
    v_warn := '{}';
    v_target := null;
    v_target_rv := null;
    v_outcome := null;
    v_stored := null;
    if exists (select 1 from jsonb_each(r.data) e where jsonb_typeof(e.value) not in ('string', 'null')) then
      v_reasons := v_reasons || 'not_text'::text;
    end if;
    if p_batch.kind = 'hotel' then
      -- An import never verifies a hotel.
      if r.data ? 'verification' then
        v_reasons := v_reasons || 'unknown_column'::text;
      end if;
      v_chk := authz.vn_hotel_check(r.data - 'verification');
    else
      v_chk := authz.vn_party_check(r.data, false);
      -- Lead ruling Q8: what the rule assumed, flagged per row.
      v_warn := v_warn || array(select jsonb_array_elements_text(coalesce(v_chk -> 'notes', '[]'::jsonb)));
    end if;
    v_reasons := v_reasons || array(select jsonb_array_elements_text(v_chk -> 'reasons'));
    v_vals := v_chk -> 'values';
    v_ref := v_vals ->> 'sourceRef';
    v_name_key := lower(coalesce(v_vals ->> 'name', ''))
      || case when p_batch.kind = 'hotel' then '|' || lower(coalesce(v_vals ->> 'city', '')) else '' end;

    if cardinality(v_reasons) > 0 then
      v_outcome := 'invalid';
    elsif v_ref is not null and coalesce((v_refs ->> v_ref)::integer, 0) > 1 then
      v_outcome := 'duplicate_in_file';
      v_reasons := array['duplicate_in_file'];
    elsif p_batch.kind = 'hotel' then
      select * into v_hotel from public.hotel_catalogue h
      where v_ref is not null and h.legal_entity_id = p_batch.legal_entity_id and h.source_ref = v_ref;
      if v_hotel.id is not null then
        v_target := v_hotel.id;
        v_target_rv := v_hotel.row_version;
        v_stored := authz.vn_hotel_fields(v_hotel);
        v_same := authz.vn_hotel_fields(v_hotel)
                  = (authz.vn_hotel_fields(v_hotel) || (authz.vn_import_present(v_vals, r.data) - 'sourceRef'));
        v_outcome := case when v_same then 'unchanged' when v_hotel.verification = 'checked' then 'skipped_checked' else 'update' end;
      else
        v_outcome := 'create';
        if exists (select 1 from public.hotel_catalogue h
                   where h.legal_entity_id = p_batch.legal_entity_id and h.name_key = lower(v_vals ->> 'name')
                     and lower(h.city) = lower(v_vals ->> 'city')) then
          v_warn := v_warn || 'same_name_stored'::text;
        end if;
      end if;
    else
      select * into v_party from public.customer_parties p
      where v_ref is not null and p.legal_entity_id = p_batch.legal_entity_id and p.source_ref = v_ref;
      if v_party.id is not null then
        v_target := v_party.id;
        v_target_rv := v_party.row_version;
        v_stored := authz.vn_party_fields(v_party);
        v_same := authz.vn_party_fields(v_party)
                  = (authz.vn_party_fields(v_party) || (authz.vn_import_present(v_vals, r.data) - 'sourceRef'));
        v_outcome := case when v_same then 'unchanged' when v_party.check_status = 'checked' then 'skipped_checked' else 'update' end;
      else
        v_outcome := 'create';
        if exists (select 1 from public.customer_parties p
                   where p.legal_entity_id = p_batch.legal_entity_id and p.name_key = lower(v_vals ->> 'name')) then
          v_warn := v_warn || 'same_name_stored'::text;
        end if;
      end if;
    end if;
    if v_outcome in ('create', 'update', 'unchanged') and coalesce((v_names ->> v_name_key)::integer, 0) > 1 then
      v_warn := v_warn || 'same_name_in_file'::text;
    end if;
    -- Echo-A L6: an update clears a stored value whose column is in the file but blank.
    if v_outcome = 'update' then
      v_present := authz.vn_import_present(v_vals, r.data) - 'sourceRef';
      v_warn := v_warn || array(select 'will_clear:' || e.key from jsonb_each(v_present) e
                                where jsonb_typeof(e.value) = 'null' and v_stored ? e.key
                                  and jsonb_typeof(v_stored -> e.key) <> 'null');
    end if;
    -- Echo-A L3: what this row will do, against which stored version.
    v_proposal := v_proposal || jsonb_build_array(jsonb_build_array(r.row_no, v_outcome, v_target, v_target_rv,
      to_jsonb(array(select distinct y from unnest(v_reasons) y order by y))));
    update public.import_rows x
    set source_ref = v_ref, outcome = v_outcome,
        reasons = array(select distinct y from unnest(v_reasons) y order by y),
        warnings = array(select distinct y from unnest(v_warn) y order by y), target_id = v_target
    where x.batch_id = r.batch_id and x.row_no = r.row_no;
  end loop;

  return jsonb_build_object(
    'batchId', p_batch.id, 'kind', p_batch.kind,
    'rows', (select count(*) from public.import_rows x where x.batch_id = p_batch.id),
    'valid', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
              and x.outcome in ('create', 'update', 'unchanged', 'skipped_checked')),
    'invalid', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'invalid'),
    'duplicatesInFile', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'duplicate_in_file'),
    'possibleDuplicates', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
                           and x.warnings && array['same_name_stored', 'same_name_in_file']),
    -- Lead ruling Q8: rows where a value was assumed (GST status registered from a GSTIN, a padded state code).
    'assumedRows', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
                    and x.warnings && array['gst_status_assumed_registered', 'state_code_padded']),
    -- Echo-A L6: rows whose update clears a stored value (note will_clear:<key>).
    'clearRows', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
                  and exists (select 1 from unnest(x.warnings) w where w like 'will\_clear:%')),
    'rowNotes', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'notes', to_jsonb(y.notes)) order by y.row_no)
      from (select x.row_no, array(select w from unnest(x.warnings) w
                                   where w not in ('same_name_stored', 'same_name_in_file') order by w) as notes
            from public.import_rows x
            where x.batch_id = p_batch.id
              and exists (select 1 from unnest(x.warnings) w where w not in ('same_name_stored', 'same_name_in_file'))
            order by x.row_no limit 200) y), '[]'::jsonb),
    -- Echo-A L3: hash of every row's outcome, target and target version.
    'proposalHash', encode(sha256(convert_to(v_proposal::text, 'UTF8')), 'hex'),
    'proposed', jsonb_build_object(
      'create', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'create'),
      'update', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'update'),
      'unchanged', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'unchanged'),
      'skippedChecked', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'skipped_checked')),
    'columns', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.k, 'filled', c.filled) order by c.k)
      from (select e.key as k, count(*) filter (where jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> '') as filled
            from public.import_rows x, jsonb_each(x.data) e where x.batch_id = p_batch.id group by e.key) c), '[]'::jsonb),
    'invalidRows', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'reasons', to_jsonb(y.reasons)) order by y.row_no)
      from (select x.row_no, x.reasons from public.import_rows x
            where x.batch_id = p_batch.id and x.outcome = 'invalid' order by x.row_no limit 200) y), '[]'::jsonb),
    'duplicateRows', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'sourceRef', y.source_ref, 'kind', y.kind) order by y.row_no, y.kind)
      from (select x.row_no, x.source_ref, case when x.outcome = 'duplicate_in_file' then 'in_file' else 'same_name' end as kind
            from public.import_rows x
            where x.batch_id = p_batch.id and (x.outcome = 'duplicate_in_file'
                                               or x.warnings && array['same_name_stored', 'same_name_in_file'])
            order by x.row_no limit 200) y), '[]'::jsonb));
end;
$$;

-- The batch as answered by every command.
create function authz.vn_import_batch_json(b public.import_batches) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(b.summary, jsonb_build_object('batchId', b.id, 'kind', b.kind, 'rows', b.row_count))
    || jsonb_build_object('batchId', b.id, 'kind', b.kind, 'status', b.status, 'rowVersion', b.row_version,
         'fileName', b.source_file_name, 'branchId', b.branch_id, 'entityWide', b.entity_wide,
         'branchName', (select x.name from public.branches x where x.id = b.branch_id),
         'uploadedByName', (select s.display_name from public.staff_profiles s where s.user_id = b.uploaded_by),
         'createdAt', b.created_at, 'validatedAt', b.validated_at, 'appliedAt', b.applied_at,
         'appliedByName', (select s.display_name from public.staff_profiles s where s.user_id = b.applied_by),
         'applyResult', b.apply_result)
$$;

-- ===========================================================================
-- 3. Commands
-- ===========================================================================

-- Stages the rows the app parsed from the CSV (1..5000 objects of at most 40
-- keys; values strings or null are checked by the validation). Idempotent by
-- (entity, request id) for the same uploader, kind and file hash.
create function public.import_batch_stage(p_legal_entity_id uuid, p_kind text, p_branch_id uuid, p_file_name text,
  p_sha256 text, p_rows jsonb, p_request_id uuid, p_entity_wide boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_existing public.import_batches%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_n integer;
begin
  if p_kind is null or p_kind not in ('hotel', 'customer') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_legal_entity_id is null or not authz.vn_import_role(p_legal_entity_id, p_kind) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_existing from public.import_batches b
  where b.legal_entity_id = p_legal_entity_id and b.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.kind <> p_kind
       or v_existing.source_sha256 <> v_sha or v_existing.branch_id is distinct from p_branch_id
       or v_existing.entity_wide <> coalesce(p_entity_wide, false) then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    return jsonb_build_object('batchId', v_existing.id, 'rowCount', v_existing.row_count, 'outcome', 'existing');
  end if;
  if v_name = '' or v_name ~ '^[. ]+$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fileName';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sha256';
  end if;
  if p_kind = 'hotel' and p_branch_id is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  -- Echo-A M1: customers need a branch, or the explicit whole-company choice (never both).
  if p_kind = 'customer' and p_branch_id is null and coalesce(p_entity_wide, false) is false then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  if coalesce(p_entity_wide, false) and (p_kind = 'hotel' or p_branch_id is not null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityWide';
  end if;
  if p_branch_id is not null and not exists (
       select 1 from public.branches b where b.id = p_branch_id and b.legal_entity_id = p_legal_entity_id) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n > 5000 then
    raise exception 'import_too_large' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
             where jsonb_typeof(e) <> 'object'
                or (select count(*) from jsonb_object_keys(e)) > 40
                or exists (select 1 from jsonb_each(e) f
                           where f.key !~ '^[A-Za-z][A-Za-z0-9]{0,39}$'
                              or (jsonb_typeof(f.value) = 'string' and char_length(f.value #>> '{}') > 1000))) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  insert into public.import_batches (id, legal_entity_id, kind, branch_id, entity_wide, request_id, source_file_name,
    source_sha256, row_count, uploaded_by)
  values (v_id, p_legal_entity_id, p_kind, p_branch_id, p_kind = 'customer' and coalesce(p_entity_wide, false), p_request_id,
    v_name, v_sha, v_n, (select auth.uid()));
  insert into public.import_rows (batch_id, row_no, legal_entity_id, data)
  select v_id, e.ordinality::integer, p_legal_entity_id, e.value
  from jsonb_array_elements(p_rows) with ordinality e;
  -- Counts and the file hash only (never a file name or a value).
  perform authz.write_audit('import.staged', p_legal_entity_id, p_branch_id, 'import_batch', v_id, null,
    jsonb_build_object('kind', p_kind, 'rows', v_n, 'sha256', v_sha, 'entityWide', p_kind = 'customer' and coalesce(p_entity_wide, false)));
  return jsonb_build_object('batchId', v_id, 'rowCount', v_n, 'outcome', 'created');
end;
$$;

-- The batch locked for a command, after the role check (not_found for
-- anyone without the role, so a batch id reveals nothing).
create function authz.vn_import_lock(p_batch_id uuid) returns public.import_batches
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
begin
  select * into b from public.import_batches x where x.id = p_batch_id for update;
  if b.id is null or not authz.vn_import_role(b.legal_entity_id, b.kind) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return b;
end;
$$;

-- Dry run: validates every row and stores the summary (writes only the import tables).
create function public.import_batch_validate(p_batch_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_summary jsonb;
begin
  b := authz.vn_import_lock(p_batch_id);
  if b.status = 'applied' then
    raise exception 'import_applied' using errcode = '55000';
  end if;
  if b.status = 'cancelled' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  v_summary := authz.vn_import_evaluate(b);
  update public.import_batches x
  set status = 'validated', summary = v_summary, validated_by = (select auth.uid()), validated_at = now(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = b.id
  returning * into b;
  perform authz.write_audit('import.validated', b.legal_entity_id, b.branch_id, 'import_batch', b.id, null,
    jsonb_build_object('kind', b.kind, 'rows', v_summary -> 'rows', 'invalid', v_summary -> 'invalid',
      'duplicatesInFile', v_summary -> 'duplicatesInFile', 'proposed', v_summary -> 'proposed'));
  return authz.vn_import_batch_json(b);
end;
$$;

-- Apply: idempotent; re-validates under locks; refuses import_stale when the
-- proposed counts differ from the dry run the caller saw (row version).
create function public.import_batch_apply(p_batch_id uuid, p_expected_row_version integer, p_reason text,
  p_proposal_hash text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_reason text;
  v_summary jsonb;
  r public.import_rows%rowtype;
  v_v jsonb;
  v_id uuid;
  v_hotel public.hotel_catalogue%rowtype;
  v_party public.customer_parties%rowtype;
  v_created integer := 0;
  v_updated integer := 0;
  v_result jsonb;
begin
  b := authz.vn_import_lock(p_batch_id);
  if b.status = 'applied' then
    return b.apply_result || jsonb_build_object('outcome', 'existing');
  end if;
  if b.status = 'cancelled' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if b.status <> 'validated' then
    raise exception 'import_not_validated' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, b.row_version);
  v_reason := authz.settings_change_reason(p_reason);

  -- Writers of the target table wait for this apply; readers do not.
  if b.kind = 'hotel' then
    lock table public.hotel_catalogue in share row exclusive mode;
  else
    lock table public.customer_parties in share row exclusive mode;
  end if;
  v_summary := authz.vn_import_evaluate(b);
  -- Echo-A L3: the screen posts the row version (and optionally the
  -- proposal hash) of the summary it showed; the re-run must give the same
  -- rows, outcomes, targets and target versions.
  if (p_proposal_hash is not null and p_proposal_hash is distinct from b.summary ->> 'proposalHash')
     or v_summary ->> 'proposalHash' is distinct from b.summary ->> 'proposalHash' then
    raise exception 'import_stale' using errcode = '40001';
  end if;

  for r in select * from public.import_rows x where x.batch_id = b.id and x.outcome in ('create', 'update') order by x.row_no loop
    if b.kind = 'hotel' then
      v_v := authz.vn_hotel_check(r.data - 'verification') -> 'values';
      if r.outcome = 'create' then
        insert into public.hotel_catalogue (legal_entity_id, name, city, area, address, star_category, source_ref, status,
          import_batch_id, created_by, updated_by)
        values (b.legal_entity_id, v_v ->> 'name', v_v ->> 'city', v_v ->> 'area', v_v ->> 'address',
          v_v ->> 'starCategory', v_v ->> 'sourceRef', v_v ->> 'status', b.id, (select auth.uid()), (select auth.uid()))
        returning id into v_id;
        v_created := v_created + 1;
        update public.import_rows x set target_id = v_id where x.batch_id = r.batch_id and x.row_no = r.row_no;
      else
        select * into v_hotel from public.hotel_catalogue h where h.id = r.target_id for update;
        -- Columns missing from the file keep the stored value.
        v_v := authz.vn_hotel_fields(v_hotel) || (authz.vn_import_present(v_v, r.data) - 'sourceRef');
        update public.hotel_catalogue h
        set name = v_v ->> 'name', city = v_v ->> 'city', area = v_v ->> 'area', address = v_v ->> 'address',
            star_category = v_v ->> 'starCategory', status = v_v ->> 'status', import_batch_id = b.id,
            row_version = h.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
        where h.id = v_hotel.id and h.verification <> 'checked';
        v_updated := v_updated + 1;
        update public.import_rows x
        set before = jsonb_build_object('name', v_hotel.name, 'city', v_hotel.city, 'area', v_hotel.area,
              'address', v_hotel.address, 'starCategory', v_hotel.star_category, 'status', v_hotel.status)
        where x.batch_id = r.batch_id and x.row_no = r.row_no;
      end if;
    else
      v_v := authz.vn_party_check(r.data, false) -> 'values';
      if r.outcome = 'create' then
        insert into public.customer_parties (legal_entity_id, branch_id, party_type, name, contact_person, phone, email,
          address_line1, address_line2, city, state_code, postal_code, gst_status, gstin, gst_reason, source_ref,
          import_batch_id, created_by, updated_by)
        values (b.legal_entity_id, b.branch_id, v_v ->> 'partyType', v_v ->> 'name', v_v ->> 'contactPerson',
          v_v ->> 'phone', v_v ->> 'email', v_v ->> 'addressLine1', v_v ->> 'addressLine2', v_v ->> 'city',
          v_v ->> 'stateCode', v_v ->> 'postalCode', v_v ->> 'gstStatus', v_v ->> 'gstin', v_v ->> 'gstReason',
          v_v ->> 'sourceRef', b.id, (select auth.uid()), (select auth.uid()))
        returning id into v_id;
        v_created := v_created + 1;
        update public.import_rows x set target_id = v_id where x.batch_id = r.batch_id and x.row_no = r.row_no;
      else
        select * into v_party from public.customer_parties p where p.id = r.target_id for update;
        -- Columns missing from the file keep the stored value.
        v_v := authz.vn_party_fields(v_party) || (authz.vn_import_present(v_v, r.data) - 'sourceRef');
        update public.customer_parties p
        set party_type = v_v ->> 'partyType', name = v_v ->> 'name', contact_person = v_v ->> 'contactPerson',
            phone = v_v ->> 'phone', email = v_v ->> 'email', address_line1 = v_v ->> 'addressLine1',
            address_line2 = v_v ->> 'addressLine2', city = v_v ->> 'city', state_code = v_v ->> 'stateCode',
            postal_code = v_v ->> 'postalCode', gst_status = v_v ->> 'gstStatus', gstin = v_v ->> 'gstin',
            gst_reason = v_v ->> 'gstReason',
            -- Never checked by an import; a returned party goes back to not_checked.
            check_status = 'not_checked', check_reason = null, checked_by = null, checked_at = null,
            import_batch_id = b.id, row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
        where p.id = v_party.id and p.check_status <> 'checked';
        v_updated := v_updated + 1;
        update public.import_rows x set before = authz.vn_party_fields(v_party)
        where x.batch_id = r.batch_id and x.row_no = r.row_no;
      end if;
    end if;
  end loop;

  v_result := jsonb_build_object('batchId', b.id, 'status', 'applied', 'created', v_created, 'updated', v_updated,
    'unchanged', (v_summary -> 'proposed' -> 'unchanged')::integer,
    'skippedChecked', (v_summary -> 'proposed' -> 'skippedChecked')::integer,
    'invalid', (v_summary ->> 'invalid')::integer + (v_summary ->> 'duplicatesInFile')::integer);
  -- Echo-A L4: the staged cells (personal data for customers) are blanked;
  -- source reference, outcome, reasons, target and previous values stay.
  update public.import_rows x set data = '{}'::jsonb where x.batch_id = b.id;
  update public.import_batches x
  set status = 'applied', summary = v_summary, apply_result = v_result, apply_reason = v_reason,
      applied_by = (select auth.uid()), applied_at = now(), row_version = x.row_version + 1, updated_at = now()
  where x.id = b.id;
  perform authz.write_audit('import.applied', b.legal_entity_id, b.branch_id, 'import_batch', b.id, v_reason,
    jsonb_build_object('kind', b.kind) || (v_result - 'batchId' - 'status'));
  return v_result;
end;
$$;

-- A batch with one page of its rows (row number, source reference, name,
-- outcome, reasons, warnings, target).
create function public.import_batch_get(p_batch_id uuid, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 5000);
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into b from public.import_batches x where x.id = p_batch_id;
  if b.id is null or not authz.vn_import_role(b.legal_entity_id, b.kind) then
    return null;
  end if;
  return jsonb_build_object('batch', authz.vn_import_batch_json(b),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'sourceRef', y.source_ref,
          'name', case when jsonb_typeof(y.data -> 'name') = 'string' then left(y.data ->> 'name', 200) end,
          'outcome', y.outcome, 'reasons', to_jsonb(y.reasons), 'warnings', to_jsonb(y.warnings), 'targetId', y.target_id)
        order by y.row_no)
      from (select * from public.import_rows x where x.batch_id = b.id order by x.row_no limit v_limit offset v_offset) y),
      '[]'::jsonb),
    'hasMore', b.row_count > v_offset + v_limit);
end;
$$;

-- Recent batches of a kind in every entity where the caller holds that kind's role.
create function public.import_batch_list(p_kind text, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entities uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('hotel', 'customer') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  select coalesce(array_agg(e), '{}') into v_entities
  from unnest(authz.vn_member_entities()) e where authz.vn_import_role(e, p_kind);
  if cardinality(v_entities) = 0 then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('batchId', y.id, 'kind', y.kind, 'fileName', y.source_file_name,
        'status', y.status, 'rows', y.row_count, 'createdAt', y.created_at,
        'uploadedByName', (select s.display_name from public.staff_profiles s where s.user_id = y.uploaded_by),
        'appliedAt', y.applied_at,
        -- Counts of an applied batch (null before apply).
        'created', (y.apply_result ->> 'created')::integer, 'updated', (y.apply_result ->> 'updated')::integer,
        'invalid', (y.apply_result ->> 'invalid')::integer) order by y.created_at desc, y.id)
    from (select * from public.import_batches x
          where x.legal_entity_id = any (v_entities) and x.kind = p_kind
          order by x.created_at desc, x.id limit least(greatest(coalesce(p_limit, 20), 1), 100)) y), '[]'::jsonb));
end;
$$;

create function public.import_batch_cancel(p_batch_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
begin
  b := authz.vn_import_lock(p_batch_id);
  if b.status = 'applied' then
    raise exception 'import_applied' using errcode = '55000';
  end if;
  if b.status = 'cancelled' then
    return jsonb_build_object('batchId', b.id, 'status', 'cancelled', 'rowVersion', b.row_version);
  end if;
  perform authz.require_row_version(p_expected_row_version, b.row_version);
  update public.import_batches x set status = 'cancelled', row_version = x.row_version + 1, updated_at = now()
  where x.id = b.id
  returning * into b;
  -- Echo-A L4: the staged cells are blanked (counts and outcomes stay).
  update public.import_rows x set data = '{}'::jsonb where x.batch_id = b.id;
  perform authz.write_audit('import.cancelled', b.legal_entity_id, b.branch_id, 'import_batch', b.id, null,
    jsonb_build_object('kind', b.kind));
  return jsonb_build_object('batchId', b.id, 'status', 'cancelled', 'rowVersion', b.row_version);
end;
$$;

-- ===========================================================================
-- 4. Privileges
-- ===========================================================================

revoke all on function authz.vn_import_role(uuid, text), authz.vn_import_evaluate(public.import_batches),
  authz.vn_import_present(jsonb, jsonb), authz.vn_hotel_fields(public.hotel_catalogue),
  authz.vn_import_batch_json(public.import_batches), authz.vn_import_lock(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.import_batch_stage(uuid, text, uuid, text, text, jsonb, uuid, boolean),
  public.import_batch_validate(uuid), public.import_batch_apply(uuid, integer, text, text),
  public.import_batch_get(uuid, integer, integer), public.import_batch_list(text, integer),
  public.import_batch_cancel(uuid, integer)
from public, anon, authenticated, service_role;
grant execute on function public.import_batch_stage(uuid, text, uuid, text, text, jsonb, uuid, boolean),
  public.import_batch_validate(uuid), public.import_batch_apply(uuid, integer, text, text),
  public.import_batch_get(uuid, integer, integer), public.import_batch_list(text, integer),
  public.import_batch_cancel(uuid, integer)
to authenticated;

commit;
