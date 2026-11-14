-- TripNavigate CRM Phase 3.5: hosted staging verification of migration 20261004000100.
--
-- Run as ONE statement batch (Supabase MCP execute_sql or psql) against the
-- STAGING project only. Everything runs inside one transaction that ends with
-- ROLLBACK: the synthetic entity, auth users, staff, deals, booking rows and
-- tasks below exist only inside it. Nothing is committed.
--
-- Impersonation mirrors crm/tests/helpers/db.ts: request.jwt.claims (local)
-- plus SET LOCAL ROLE authenticated|anon|service_role, per probe.
--
-- It does NOT change booking_settings, deployment_settings or intake config.
-- Because staging has deployment_settings.environment = 'unset', every
-- booking command refuses with environment_unset before the real-booking gate
-- is reached, so booking rows are created by the table owner (as a migration
-- or operator would) and the API-facing behaviour is probed against them.
--
-- Output: one row {total, passed, failed:[...]}; each failure shows the probe
-- name, the expectation and the actual result (codes only, no row contents).

begin;

create temp table _r (name text primary key, expect jsonb, actual jsonb, pass boolean) on commit drop;

-- probe(name, user, role, sql, expect)
--   expect {"code": "<sqlstate>"} -> the statement must fail with that SQLSTATE
--   expect {"v": <json>}          -> the statement must return exactly that jsonb
create function pg_temp.probe(p_name text, p_user uuid, p_role text, p_sql text, p_expect jsonb)
returns void language plpgsql as $f$
declare
  v jsonb;
  a jsonb;
  t bigint := extract(epoch from now())::bigint;
begin
  perform set_config('request.jwt.claims',
    case when p_role = 'authenticated' then jsonb_build_object(
      'sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'aud', 'authenticated', 'iat', t, 'exp', t + 900,
      'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', t - 60),
                               jsonb_build_object('method', 'totp', 'timestamp', t - 60)))::text
    else jsonb_build_object('role', p_role)::text end, true);
  begin
    execute format('set local role %I', p_role);
    execute p_sql into v;
    reset role;
    a := jsonb_build_object('v', v);
  exception when others then
    a := jsonb_build_object('code', sqlstate, 'msg', left(sqlerrm, 60));
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  insert into _r values (p_name, p_expect, a,
    case when p_expect ? 'code' then a ->> 'code' = p_expect ->> 'code' else a -> 'v' = p_expect -> 'v' end);
end;
$f$;

do $$
declare
  e uuid := gen_random_uuid();          -- synthetic legal entity
  b1 uuid := gen_random_uuid();         -- branch 1
  b2 uuid := gen_random_uuid();         -- branch 2
  own uuid := gen_random_uuid();        -- Sales, owner of both deals (branch 1)
  sal2 uuid := gen_random_uuid();       -- Sales, assignee (not owner) of the real deal
  mgr uuid := gen_random_uuid();        -- manager, branch 1, deal.read grant on branch 1
  mgr2 uuid := gen_random_uuid();       -- manager, branch 2, deal.read grant on branch 1
  pur uuid := gen_random_uuid();        -- Purchase, assigned to the synthetic deal
  adm uuid := gen_random_uuid();        -- super_admin (grantor)
  ib uuid := gen_random_uuid();         -- intake inbox row for the real deal
  ds uuid := gen_random_uuid();         -- synthetic deal
  dr uuid := gen_random_uuid();         -- real (Bitrix-sourced) deal
  vs uuid := gen_random_uuid();         -- confirmed version on ds
  vr uuid := gen_random_uuid();         -- ready draft version on dr
  e1 uuid := gen_random_uuid();         -- stored evidence on vs
  e2 uuid := gen_random_uuid();         -- stored evidence on vr
  ts uuid := gen_random_uuid();         -- Purchase task for vs
  hr text;                              -- live content hash of vr
  q text;
begin
  -- Identity fixtures (synthetic, rolled back).
  insert into auth.users (id, email)
  select u, 'staging-verify-' || left(u::text, 8) || '@example.invalid'
  from unnest(array[own, sal2, mgr, mgr2, pur, adm]) u;
  insert into public.legal_entities (id, code, legal_name, status, is_synthetic)
  values (e, 'ZZ_STAGING_VERIFY', 'Synthetic staging verification entity', 'enabled', true);
  insert into public.branches (id, legal_entity_id, code, name, state_name, is_head_office, status) values
    (b1, e, 'ZZB1', 'Synthetic branch 1', 'Synthetic', false, 'enabled'),
    (b2, e, 'ZZB2', 'Synthetic branch 2', 'Synthetic', false, 'enabled');
  insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
  select u, 'Synthetic ' || r, 'staging-verify-' || left(u::text, 8) || '@example.invalid', 'active', now()
  from (values (own, 'owner'), (sal2, 'sales2'), (mgr, 'manager1'), (mgr2, 'manager2'), (pur, 'purchase'), (adm, 'admin')) x(u, r);
  insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status) values
    (own, e, b1, 'sales', 'active'), (sal2, e, b1, 'sales', 'active'), (mgr, e, b1, 'manager', 'active'),
    (mgr2, e, b2, 'manager', 'active'), (pur, e, b1, 'purchase', 'active'), (adm, e, b1, 'super_admin', 'active');
  insert into public.access_grants (user_id, permission_code, legal_entity_id, branch_id, reason, granted_by, starts_at)
  values (mgr, 'deal.read', e, b1, 'SYNTHETIC staging verification', adm, now() - interval '1 day'),
         (mgr2, 'deal.read', e, b1, 'SYNTHETIC staging verification', adm, now() - interval '1 day');

  -- Deals: one synthetic, one real (Bitrix provenance, verified just now).
  insert into public.integration_inbox (id, portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, next_attempt_at)
  values (ib, 'zzstagingverify', 'ONCRMDEALADD', 990000001, extract(epoch from now())::bigint,
          encode(sha256(convert_to(ib::text, 'UTF8')), 'hex'), 'processed', null);
  insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
  values (ds, e, b1, 'SYN-STG-0001', 'Synthetic staging deal', own, true);
  insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
    source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at,
    source_modified_at, last_synced_at, last_verified_at, intake_inbox_id)
  values (dr, e, b1, 'BX-990000001', 'Synthetic stand-in for a Bitrix deal', own, false,
    'bitrix', 'zzstagingverify', 990000001, 'NEW', 0, now(), now(), now(), now(), ib);
  insert into public.deal_commercials (deal_id, legal_entity_id, selling_total_paise, estimated_margin_paise, is_synthetic)
  values (ds, e, 9876543, 1234567, true);
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by) values
    (ds, e, pur, 'purchase', adm), (dr, e, sal2, 'sales', adm);

  -- Booking rows as the table owner (commands refuse while environment = 'unset').
  insert into public.booking_versions (id, deal_id, legal_entity_id, branch_id, version_no, created_by,
    hotel_name, city, check_in, check_out, rooms, adults, children, purchase_budget_paise)
  values
    (vs, ds, e, b1, 1, own, 'Synthetic Hotel', 'Synthetic City', date '2026-12-10', date '2026-12-13', 2, 3, 1, 4500000),
    (vr, dr, e, b1, 1, own, 'Synthetic Hotel', 'Synthetic City', date '2026-12-10', date '2026-12-13', 2, 3, 1, 4500000);
  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise)
  values (vs, e, 9876543), (vr, e, 9876543);
  insert into public.booking_evidence (id, version_id, deal_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values
    (e1, vs, ds, e, 'acceptance_message', e::text || '/' || ds::text || '/' || vs::text || '/' || e1::text, 'proof.pdf', 'application/pdf', 2048, repeat('a', 64), own),
    (e2, vr, dr, e, 'acceptance_message', e::text || '/' || dr::text || '/' || vr::text || '/' || e2::text, 'proof.pdf', 'application/pdf', 2048, repeat('b', 64), own);
  update public.booking_evidence set status = 'stored', stored_at = now() where id in (e1, e2);
  update public.booking_versions set status = 'confirmed', confirmed_by = own, confirmed_at = now() where id = vs;
  insert into public.fulfilment_tasks (id, deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by)
  values (ts, ds, e, b1, vs, 'booking:' || vs::text || ':hotel', own);
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload) values
    (e, 'booking_version', vs, 'booking.version_confirmed', jsonb_build_object('version_id', vs, 'task_id', ts)),
    (e, 'fulfilment_task', ts, 'fulfilment.task_created', jsonb_build_object('task_id', ts, 'version_id', vs));
  select content_hash into hr from public.booking_versions where id = vr;

  -- ---------------------------------------------------------------- gate
  perform pg_temp.probe('gate.real_booking_enabled_false', null, 'postgres',
    'select to_jsonb(real_booking_enabled) from public.booking_settings', '{"v": false}');
  perform pg_temp.probe('gate.no_api_write_privilege_on_booking_settings', null, 'postgres',
    $q$select to_jsonb(bool_or(has_table_privilege(r, 'public.booking_settings', p)))
       from unnest(array['anon','authenticated','service_role']) r, unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p$q$,
    '{"v": false}');
  perform pg_temp.probe('gate.authenticated_update_booking_settings_refused', own, 'authenticated',
    'update public.booking_settings set real_booking_enabled = true returning to_jsonb(real_booking_enabled)', '{"code": "42501"}');
  perform pg_temp.probe('gate.service_role_update_booking_settings_refused', null, 'service_role',
    'update public.booking_settings set real_booking_enabled = true returning to_jsonb(real_booking_enabled)', '{"code": "42501"}');
  q := format('select public.booking_confirm(%L, %L)', vr, hr);
  perform pg_temp.probe('gate.owner_confirm_real_deal_refused_environment_unset', own, 'authenticated', q, '{"code": "55000"}');
  perform pg_temp.probe('gate.branch_manager_confirm_real_deal_refused_environment_unset', mgr, 'authenticated', q, '{"code": "55000"}');
  perform pg_temp.probe('gate.readiness_reports_environment_unset', own, 'authenticated',
    format('select to_jsonb((public.booking_readiness(%L) -> ''issues'') ? ''environment_unset'')', vr), '{"v": true}');
  perform pg_temp.probe('gate.owner_open_draft_refused_environment_unset', own, 'authenticated',
    format('select public.booking_open_draft(%L)', ds), '{"code": "55000"}');
  perform pg_temp.probe('gate.real_deal_still_draft_after_attempts', null, 'postgres',
    format('select to_jsonb(status) from public.booking_versions where id = %L', vr), '{"v": "draft"}');

  -- ---------------------------------------------------------------- confirm authority (P3-06)
  perform pg_temp.probe('authz.sales_assignee_not_owner_confirm_refused', sal2, 'authenticated', q, '{"code": "42501"}');
  perform pg_temp.probe('authz.other_branch_manager_confirm_refused', mgr2, 'authenticated', q, '{"code": "42501"}');
  perform pg_temp.probe('authz.purchase_confirm_refused', pur, 'authenticated', q, '{"code": "42501"}');
  perform pg_temp.probe('authz.anon_confirm_refused', null, 'anon', q, '{"code": "42501"}');
  perform pg_temp.probe('authz.repeat_confirm_of_confirmed_version_returns_existing', own, 'authenticated',
    format('select public.booking_confirm(%L, %L) -> ''outcome''', vs, repeat('0', 64)), '{"v": "existing"}');

  -- ---------------------------------------------------------------- RLS (owner view)
  perform pg_temp.probe('rls.owner_sees_2_versions', own, 'authenticated',
    'select to_jsonb(count(*)) from public.booking_versions', '{"v": 2}');
  perform pg_temp.probe('rls.owner_sees_2_commercials', own, 'authenticated',
    'select to_jsonb(count(*)) from public.booking_version_commercials', '{"v": 2}');
  perform pg_temp.probe('rls.owner_sees_2_evidence', own, 'authenticated',
    'select to_jsonb(count(*)) from public.booking_evidence', '{"v": 2}');
  perform pg_temp.probe('rls.owner_sees_1_task', own, 'authenticated',
    'select to_jsonb(count(*)) from public.fulfilment_tasks', '{"v": 1}');
  perform pg_temp.probe('rls.commercial_revision_column_refused', own, 'authenticated',
    'select to_jsonb(count(commercial_revision)) from public.booking_versions', '{"code": "42501"}');
  perform pg_temp.probe('rls.outbox_refused_for_authenticated', own, 'authenticated',
    'select to_jsonb(count(*)) from public.outbox_events', '{"code": "42501"}');
  perform pg_temp.probe('rls.direct_insert_version_refused', own, 'authenticated',
    format('insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by) values (%L, %L, %L, 9, %L) returning to_jsonb(id)', ds, e, b1, own),
    '{"code": "42501"}');
  perform pg_temp.probe('rls.direct_update_task_refused', own, 'authenticated',
    'update public.fulfilment_tasks set status = ''in_progress'' returning to_jsonb(id)', '{"code": "42501"}');
  perform pg_temp.probe('rls.owner_panel_has_selling_total', own, 'authenticated',
    format('select to_jsonb((public.booking_panel(%L) -> ''version'') ? ''sellingTotalPaise'')', ds), '{"v": true}');
  perform pg_temp.probe('rls.manager_other_branch_sees_no_evidence', mgr2, 'authenticated',
    'select to_jsonb(count(*)) from public.booking_evidence', '{"v": 0}');
  perform pg_temp.probe('rls.anon_booking_versions_refused', null, 'anon',
    'select to_jsonb(count(*)) from public.booking_versions', '{"code": "42501"}');
  perform pg_temp.probe('rls.anon_booking_settings_refused', null, 'anon',
    'select to_jsonb(count(*)) from public.booking_settings', '{"code": "42501"}');
  perform pg_temp.probe('rls.service_role_reads_outbox', null, 'service_role',
    'select to_jsonb(count(*) >= 2) from public.outbox_events', '{"v": true}');
  perform pg_temp.probe('rls.service_role_insert_task_refused', null, 'service_role',
    format('insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by) values (%L, %L, %L, %L, %L, %L) returning to_jsonb(id)', dr, e, b1, vr, 'booking:' || vr::text || ':hotel', own),
    '{"code": "42501"}');

  -- ---------------------------------------------------------------- Purchase isolation (P3-07)
  perform pg_temp.probe('purchase.sees_assigned_deal_header', pur, 'authenticated',
    format('select to_jsonb(count(*)) from public.deals where id = %L', ds), '{"v": 1}');
  perform pg_temp.probe('purchase.no_booking_versions', pur, 'authenticated',
    'select to_jsonb(count(*)) from public.booking_versions', '{"v": 0}');
  perform pg_temp.probe('purchase.no_booking_commercials', pur, 'authenticated',
    'select to_jsonb(count(*)) from public.booking_version_commercials', '{"v": 0}');
  perform pg_temp.probe('purchase.no_booking_evidence', pur, 'authenticated',
    'select to_jsonb(count(*)) from public.booking_evidence', '{"v": 0}');
  perform pg_temp.probe('purchase.no_deal_commercials', pur, 'authenticated',
    'select to_jsonb(count(*)) from public.deal_commercials', '{"v": 0}');
  perform pg_temp.probe('purchase.outbox_refused', pur, 'authenticated',
    'select to_jsonb(count(*)) from public.outbox_events', '{"code": "42501"}');
  perform pg_temp.probe('purchase.sees_entity_task_row', pur, 'authenticated',
    'select to_jsonb(count(*)) from public.fulfilment_tasks', '{"v": 1}');
  perform pg_temp.probe('purchase.task_list_has_one_task', pur, 'authenticated',
    'select to_jsonb(jsonb_array_length(public.purchase_task_list()))', '{"v": 1}');
  perform pg_temp.probe('purchase.task_list_and_detail_keys_exact', pur, 'authenticated',
    format($q$select to_jsonb(array(select u.k from (select k from jsonb_object_keys(public.purchase_task_list() -> 0) k
       union select k from jsonb_object_keys(public.purchase_task_get(%L)) k) u order by u.k collate "C"))$q$, ts),
    '{"v": ["adults","assignedToYou","assigneeName","branchName","canClaim","checkIn","checkOut","children","city","confirmedAt","confirmedByName","createdAt","dealReference","hotelName","inclusions","mealPlan","nights","purchaseBudgetPaise","roomType","rooms","specialRequests","status","taskId","versionNo"]}');
  perform pg_temp.probe('purchase.task_payload_has_no_selling_or_margin_value', pur, 'authenticated',
    format($q$select to_jsonb(position('9876543' in public.purchase_task_list()::text || public.purchase_task_get(%L)::text) = 0
       and position('1234567' in public.purchase_task_list()::text || public.purchase_task_get(%L)::text) = 0)$q$, ts, ts),
    '{"v": true}');
  perform pg_temp.probe('purchase.booking_panel_null', pur, 'authenticated',
    format('select coalesce(public.booking_panel(%L), ''"null"''::jsonb)', ds), '{"v": "null"}');
  perform pg_temp.probe('purchase.evidence_download_refused', pur, 'authenticated',
    format('select public.booking_authorize_evidence_download(%L)', e1), '{"code": "42501"}');
  perform pg_temp.probe('purchase.readiness_refused', pur, 'authenticated',
    format('select public.booking_readiness(%L)', vr), '{"code": "42501"}');
  perform pg_temp.probe('purchase.open_draft_refused', pur, 'authenticated',
    format('select public.booking_open_draft(%L)', ds), '{"code": "42501"}');
  perform pg_temp.probe('purchase.claim_succeeds', pur, 'authenticated',
    format('select public.purchase_task_claim(%L) -> ''status''', ts), '{"v": "in_progress"}');
  perform pg_temp.probe('purchase.claim_by_sales_refused', own, 'authenticated',
    format('select public.purchase_task_claim(%L)', ts), '{"code": "42501"}');

  -- ---------------------------------------------------------------- immutability (owner-level writes)
  perform pg_temp.probe('immutable.update_confirmed_version_refused', null, 'postgres',
    format('update public.booking_versions set hotel_name = ''x'' where id = %L returning to_jsonb(id)', vs), '{"code": "42501"}');
  perform pg_temp.probe('immutable.delete_confirmed_version_refused', null, 'postgres',
    format('delete from public.booking_versions where id = %L returning to_jsonb(id)', vs), '{"code": "42501"}');
  perform pg_temp.probe('immutable.update_confirmed_commercials_refused', null, 'postgres',
    format('update public.booking_version_commercials set selling_total_paise = 1 where version_id = %L returning to_jsonb(version_id)', vs), '{"code": "42501"}');
  perform pg_temp.probe('immutable.add_evidence_to_confirmed_refused', null, 'postgres',
    format($q$insert into public.booking_evidence (id, version_id, deal_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
       select x, %L, %L, %L, 'other', %L || '/' || %L || '/' || %L || '/' || x::text, 'p.pdf', 'application/pdf', 10, repeat('c', 64), %L
       from gen_random_uuid() x returning to_jsonb(id)$q$, vs, ds, e, e, ds, vs, own), '{"code": "42501"}');
  perform pg_temp.probe('immutable.delete_task_refused', null, 'postgres',
    format('delete from public.fulfilment_tasks where id = %L returning to_jsonb(id)', ts), '{"code": "42501"}');
  perform pg_temp.probe('immutable.second_task_for_version_refused', null, 'postgres',
    format('insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by) values (%L, %L, %L, %L, %L, %L) returning to_jsonb(id)', ds, e, b1, vs, 'booking:' || vs::text || ':hotel', own),
    '{"code": "23505"}');

  -- ---------------------------------------------------------------- private proof storage
  perform pg_temp.probe('storage.bucket_private_4mib_4_mime', null, 'postgres',
    $q$select to_jsonb(public = false and file_size_limit = 4194304
        and allowed_mime_types::text[] @> array['application/pdf','image/jpeg','image/png','image/webp']
        and cardinality(allowed_mime_types) = 4) from storage.buckets where id = 'booking-evidence'$q$, '{"v": true}');
  perform pg_temp.probe('storage.no_objects_policy_mentions_booking_evidence', null, 'postgres',
    $q$select to_jsonb(count(*)) from pg_policies where schemaname = 'storage'
        and (coalesce(qual, '') || coalesce(with_check, '')) like '%booking-evidence%'$q$, '{"v": 0}');
  perform pg_temp.probe('storage.objects_rls_enabled', null, 'postgres',
    $q$select to_jsonb(relrowsecurity) from pg_class where oid = 'storage.objects'::regclass$q$, '{"v": true}');
  perform pg_temp.probe('storage.authenticated_sees_no_objects', own, 'authenticated',
    $q$select to_jsonb(count(*)) from storage.objects where bucket_id = 'booking-evidence'$q$, '{"v": 0}');
end;
$$;

select jsonb_build_object(
  'total', count(*),
  'passed', count(*) filter (where pass),
  'failed', coalesce(jsonb_agg(jsonb_build_object('name', name, 'expect', expect, 'actual', actual)) filter (where not pass), '[]'::jsonb),
  'names', jsonb_agg(name order by name)
) as result
from _r;

rollback;
