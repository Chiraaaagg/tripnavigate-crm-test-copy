-- SYNTHETIC FIXTURE - NOT BUSINESS POLICY, NOT REAL STAFF, NOT REAL CUSTOMERS.
--
-- Accounts phase 3 contract (12 Nov 2026) section 19, lead fixtures: the
-- business scenarios the Phase 3 tracks and journeys need.
--
-- OPT-IN. This file is in a subdirectory on purpose (like journeys/): the seed
-- loader and the database test harness read only the top-level fixture files,
-- so the policy-parity suites keep their exact fixture Deals. Load it:
--   * PGlite / one test connection: loadAcc3Scenarios(db) (tests/helpers/db.ts),
--     inside the test's own transaction (asOwner) or committed;
--   * a disposable real stack, once, after scripts/seed-local.mjs:
--       psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/fixtures/phase3/acc3_scenarios.sql
-- It has no begin/commit of its own (the caller's transaction holds it) and
-- is rerun-safe: each scenario is built only when its Deal does not exist,
-- and the Hindi preference is added when its table appears later.
-- Loading it adds four Deals to Delhi: suites that count every Deal (the
-- policy-parity suites on a real stack) must run before it, or on a reset stack.
--
-- Every row is made through the existing commands, impersonating the
-- synthetic staff exactly as the database suites do (verified JWT claims plus
-- SET LOCAL ROLE authenticated). Owner SQL is used only for the established
-- SYNTHETIC FIXTURE STEPS: the Deal rows, storage objects for uploaded files,
-- catalogue hotels, an approved company bank destination, and switching
-- service items on for the build (the previous value is restored).
--
-- People (all @example.test): Sales Delhi A (owner of every scenario Deal),
-- Manager Delhi (approves the supplier's bank details), Purchase Jodhpur,
-- Accounts Jodhpur (A: records), Accounts Jodhpur 2 (second Accounts person:
-- verifies; its membership is switched on for the build and back off after,
-- if it was off). Money in paise.
--
-- Scenarios (stable ids):
--   d...0301 SYN-ACC3-HINDI   confirmed hotel booking, contact with e-mail and
--            mobile 6000000301, customer language Hindi (deal_message_prefs);
--            Accounts review still pending (approving it is the first message event).
--   d...0302 SYN-ACC3-NOMAIL  confirmed hotel booking, booking contact with a
--            mobile (6000000302) and NO e-mail; review pending.
--   d...0303 SYN-ACC3-HOTELS  committed: two hotel items, both Purchase tasks
--            supplier-confirmed (supplier "SYN Acc3 Stays", catalogue hotels
--            SYN-ACC3-H-001 / -002), review approved, one verified customer
--            receipt (2,000,000), and one supplier payment of 900,000 approved
--            and recorded by Accounts Jodhpur, verified by Accounts Jodhpur 2.
--   d...0304 SYN-ACC3-BAL3    trip ended (12 to 8 days ago), selling 1,000,300,
--            review approved, one verified receipt of 1,000,000: balance 300
--            paise (Rs 3) for the write-off journeys.

-- Guard: synthetic data only ever goes into a database labelled 'test'.
do $$
begin
  if coalesce((select s.environment from public.deployment_settings s where s.id), 'missing') <> 'test' then
    raise exception 'acc3_scenarios.sql loads only into a database whose deployment environment is test';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers (session-local, pg_temp)
-- ---------------------------------------------------------------------------

-- Verified JWT claims of an MFA session that signed in a minute ago.
create or replace function pg_temp.acc3_claims(p_user uuid) returns text
language sql stable as $$
  select jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2', 'aud', 'authenticated',
    'iat', floor(extract(epoch from now()))::bigint, 'exp', floor(extract(epoch from now()))::bigint + 900,
    'amr', jsonb_build_array(
      jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch from now()))::bigint - 60),
      jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now()))::bigint - 60)))::text
$$;

-- Runs one statement as `p_user` (a Data API request) and returns its jsonb result.
create or replace function pg_temp.acc3_as(p_user uuid, p_sql text) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claims', pg_temp.acc3_claims(p_user), true);
  execute 'set local role authenticated';
  execute p_sql into v;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- SYNTHETIC FIXTURE STEP: the uploaded file exists in storage (as the browser upload would leave it).
create or replace function pg_temp.acc3_store(p_bucket text, p_path text) returns void
language sql as $$
  insert into storage.objects (bucket_id, name, metadata) values (p_bucket, p_path, jsonb_build_object('size', 2048::bigint))
$$;

create or replace function pg_temp.acc3_sha(p_seed text) returns text
language sql immutable as $$ select md5(p_seed) || md5(p_seed || ':2') $$;

-- Opens, fills and confirms a package booking on p_deal as its owner; returns the confirmed version.
-- p_items: [{type, facts, budget}]; two adult travellers on every item; one instalment = selling.
create or replace function pg_temp.acc3_book(p_deal uuid, p_owner uuid, p_items jsonb, p_selling bigint, p_trip jsonb,
  p_contact jsonb, p_due date) returns uuid
language plpgsql as $$
declare
  r jsonb;
  v_version uuid;
  v_rv integer;
  v_item jsonb;
  v_items uuid[] := '{}';
  v_id uuid;
  v_seq integer;
  v_billing boolean;
begin
  r := pg_temp.acc3_as(p_owner, format('select public.booking_open_draft(%L::uuid) as r', p_deal));
  v_version := (r ->> 'versionId')::uuid;
  v_rv := (r ->> 'rowVersion')::integer;
  for v_item in select value from jsonb_array_elements(p_items) loop
    r := pg_temp.acc3_as(p_owner, format('select public.service_item_add(%L::uuid, %s, %L, %L::jsonb, %L::bigint, %L::uuid) as r',
      v_version, v_rv, v_item ->> 'type', v_item -> 'facts', v_item ->> 'budget', gen_random_uuid()));
    v_rv := (r ->> 'rowVersion')::integer;
    v_items := v_items || (r ->> 'itemId')::uuid;
  end loop;
  r := pg_temp.acc3_as(p_owner, format('select public.deal_travellers_save(%L::uuid, %s, %L::jsonb) as r', p_deal, v_rv,
    '[{"fullName": "Synthetic Traveller One", "type": "adult", "seq": 1}, {"fullName": "Synthetic Traveller Two", "type": "adult", "seq": 2}]'));
  v_rv := (r ->> 'rowVersion')::integer;
  r := pg_temp.acc3_as(p_owner, format('select public.booking_save_draft(%L::uuid, %s, %L::jsonb, %L::bigint, true) as r', v_version, v_rv,
    '{"hotelName": null, "city": null, "checkIn": null, "checkOut": null, "rooms": null, "roomType": null, "mealPlan": null, "adults": null, "children": null, "inclusions": null, "specialRequests": null, "purchaseBudgetPaise": null}',
    p_selling));
  v_rv := (r ->> 'rowVersion')::integer;
  r := pg_temp.acc3_as(p_owner, format('select public.booking_trip_save(%L::uuid, %s, %L::jsonb) as r', v_version, v_rv, p_trip));
  v_rv := (r ->> 'rowVersion')::integer;
  v_billing := exists (select 1 from public.customer_billing_profiles b where b.deal_id = p_deal);
  r := pg_temp.acc3_as(p_owner, format('select public.booking_customer_save(%L::uuid, %s, %L::jsonb, %L::jsonb, 0, %L::uuid) as r',
    v_version, v_rv, p_contact,
    case when v_billing then null else '{"billingName": "Synthetic Billing Name", "addressLine1": "1 Synthetic Road", "addressLine2": null, "city": "Jodhpur", "stateCode": "08", "postalCode": "342001", "gstin": null}' end,
    gen_random_uuid()));
  v_rv := (r ->> 'rowVersion')::integer;
  foreach v_id in array v_items loop
    r := pg_temp.acc3_as(p_owner, format('select public.service_item_travellers_save(%L::uuid, %L::uuid, %s, %L::integer[]) as r',
      v_id, v_version, v_rv, '{1,2}'));
    v_rv := (r ->> 'rowVersion')::integer;
  end loop;
  r := pg_temp.acc3_as(p_owner, format('select public.booking_instalments_save(%L::uuid, %s, %L::jsonb) as r', v_version, v_rv,
    jsonb_build_array(jsonb_build_object('seq', 1, 'label', 'Full payment', 'amountPaise', p_selling::text, 'dueDate', p_due))));
  for v_seq in 1..2 loop
    r := pg_temp.acc3_as(p_owner, format('select public.traveller_id_proof_begin(%L::uuid, %s, %L::uuid, true, %L, %L, 2048, %L) as r',
      p_deal, v_seq, gen_random_uuid(), 'id-proof-' || v_seq || '.jpg', 'image/jpeg', pg_temp.acc3_sha(p_deal::text || ':id:' || v_seq)));
    perform pg_temp.acc3_store('traveller-id-proofs', r ->> 'objectPath');
    perform pg_temp.acc3_as(p_owner, format('select public.traveller_id_proof_finish(%L::uuid, true) as r', r ->> 'fileId'));
  end loop;
  r := pg_temp.acc3_as(p_owner, format('select public.booking_begin_evidence(%L::uuid, %L, %L, %L, 2048, %L) as r',
    v_version, 'acceptance_message', 'acceptance.pdf', 'application/pdf', pg_temp.acc3_sha(p_deal::text || ':acceptance')));
  perform pg_temp.acc3_store('booking-evidence', r ->> 'objectPath');
  perform pg_temp.acc3_as(p_owner, format('select public.booking_finish_evidence(%L::uuid, true) as r', r ->> 'evidenceId'));
  r := pg_temp.acc3_as(p_owner, format('select public.booking_readiness(%L::uuid) as r', v_version));
  if jsonb_array_length(coalesce(r -> 'issues', '[]'::jsonb)) > 0 then
    raise exception 'acc3 fixture: booking not ready for %: %', p_deal, r -> 'issues';
  end if;
  perform pg_temp.acc3_as(p_owner, format('select public.booking_confirm(%L::uuid, %L) as r', v_version, r ->> 'contentHash'));
  return v_version;
end;
$$;

-- Accounts saves and verifies the billing details, then approves the booking version.
create or replace function pg_temp.acc3_approve(p_deal uuid, p_version uuid, p_acc uuid) returns void
language plpgsql as $$
declare
  r jsonb;
begin
  r := pg_temp.acc3_as(p_acc, format('select public.accounts_billing_save(%L::uuid, %s, %L::jsonb, %L::uuid) as r', p_deal,
    coalesce((select b.row_version from public.customer_billing_profiles b where b.deal_id = p_deal), 0),
    '{"billingName": "Synthetic Billing Name", "addressLine1": "1 Synthetic Road", "addressLine2": null, "city": "Jodhpur", "stateCode": "08", "postalCode": "342001", "gstin": null}',
    gen_random_uuid()));
  perform pg_temp.acc3_as(p_acc, format('select public.accounts_billing_verify(%L::uuid, %s, %L::uuid) as r', p_deal, r ->> 'rowVersion', gen_random_uuid()));
  perform pg_temp.acc3_as(p_acc, format('select public.accounts_review_approve(%L::uuid, %s, %L::uuid) as r', p_version,
    coalesce((select a.row_version from public.accounts_booking_reviews a where a.booking_version_id = p_version), 0), gen_random_uuid()));
end;
$$;

-- An approved synthetic company bank destination (SYNTHETIC FIXTURE STEP, the finance-support pattern).
create or replace function pg_temp.acc3_destination(p_entity uuid, p_maker uuid, p_checker uuid) returns uuid
language plpgsql as $$
declare
  v_dest uuid;
  v_version uuid;
begin
  select d.current_version_id into v_version from public.company_destinations d
  where d.legal_entity_id = p_entity and d.label = 'SYN Acc3 fixture bank' and d.retired_at is null and d.current_version_id is not null;
  if v_version is not null then
    return v_version;
  end if;
  insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
  values (p_entity, 'bank', 'SYN Acc3 fixture bank', true, p_maker) returning id into v_dest;
  insert into public.company_destination_versions (legal_entity_id, destination_id, version_no, holder_name, bank_name,
    account_number, ifsc, payee_name, upi_id, status, maker, request_id, decided_by, decided_at)
  values (p_entity, v_dest, 1, 'Synthetic Holder', 'Synthetic Bank', '000123456789', 'SYNB0000001', null, null, 'approved',
    p_maker, gen_random_uuid(), p_checker, now()) returning id into v_version;
  update public.company_destinations set current_version_id = v_version where id = v_dest;
  return v_version;
end;
$$;

-- A bank receipt recorded with its proof by p_acc and verified by p_acc2; returns the receipt id.
create or replace function pg_temp.acc3_receipt(p_deal uuid, p_amount bigint, p_ref text, p_acc uuid, p_acc2 uuid) returns uuid
language plpgsql as $$
declare
  r jsonb;
  v_receipt uuid;
  d public.deals%rowtype;
begin
  select * into d from public.deals where id = p_deal;
  r := pg_temp.acc3_as(p_acc, format('select public.receipt_record(%L::uuid, %L::jsonb, %L::uuid) as r', p_deal,
    jsonb_build_object('mode', 'bank_transfer', 'amountPaise', p_amount::text, 'receivedOn', authz.finance_today(),
      'branchId', d.branch_id, 'payerName', 'Synthetic Payer', 'payerPan', 'ABCDE1234F', 'reference', p_ref,
      'destinationVersionId', pg_temp.acc3_destination(d.legal_entity_id, p_acc, p_acc2)),
    gen_random_uuid()));
  v_receipt := (r ->> 'id')::uuid;
  r := pg_temp.acc3_as(p_acc, format('select public.finance_evidence_begin(%L, %L::uuid, %L, %L, %L, 2048, %L, %L::uuid) as r',
    'receipt', v_receipt, 'bank_proof', 'proof.pdf', 'application/pdf', pg_temp.acc3_sha(v_receipt::text), gen_random_uuid()));
  perform pg_temp.acc3_store('finance-evidence', r ->> 'objectPath');
  perform pg_temp.acc3_as(p_acc, format('select public.finance_evidence_finish(%L::uuid, true) as r', r ->> 'id'));
  perform pg_temp.acc3_as(p_acc2, format('select public.receipt_verify(%L::uuid, %L::uuid) as r', v_receipt, gen_random_uuid()));
  return v_receipt;
end;
$$;

-- Purchase takes a hotel task, quotes p_supplier for a catalogue hotel, proposes the cost, sends the booking
-- request, Accounts approves the go-ahead, Purchase stores the supplier's confirmation and confirms.
create or replace function pg_temp.acc3_hotel_confirmed(p_task uuid, p_supplier uuid, p_hotel uuid, p_hotel_name text,
  p_cost bigint, p_reference text, p_purchase uuid, p_acc uuid) returns void
language plpgsql as $$
declare
  r jsonb;
  g record;
begin
  perform pg_temp.acc3_as(p_purchase, format('select public.purchase_task_claim(%L::uuid) as r', p_task));
  r := pg_temp.acc3_as(p_purchase, format('select public.purchase_quote_add(%L::uuid, %L::uuid, %L::jsonb) as r', p_task, gen_random_uuid(),
    jsonb_build_object('supplierId', p_supplier, 'hotelName', p_hotel_name, 'roomType', 'Deluxe Room', 'mealPlan', 'Breakfast',
      'quotedCostPaise', p_cost::text, 'holdUntil', null, 'cancellationTerms', null, 'catalogueHotelId', p_hotel)));
  perform pg_temp.acc3_as(p_purchase, format('select public.purchase_cost_propose(%L::uuid, %L::uuid, 0, %s::bigint, null::date, null, %L::uuid) as r',
    p_task, r ->> 'quoteId', p_cost, gen_random_uuid()));
  perform pg_temp.acc3_as(p_purchase, format('select public.purchase_booking_request_send(%L::uuid, 1, %L, %L::text[], %L, %L, %L::uuid) as r',
    p_task, 'desk.acc3@example.test', '{}', 'Booking request SYN Acc3', 'Synthetic body.', gen_random_uuid()));
  select q.id, q.row_version into g from public.purchase_go_ahead_requests q where q.task_id = p_task and q.status = 'pending';
  perform pg_temp.acc3_as(p_acc, format('select public.purchase_go_ahead_decide(%L::uuid, %L, null, %s, %L::uuid) as r',
    g.id, 'approve', g.row_version, gen_random_uuid()));
  r := pg_temp.acc3_as(p_purchase, format('select public.purchase_evidence_begin(%L::uuid, %L, %L, %L, 2048, %L) as r',
    p_task, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', pg_temp.acc3_sha(p_task::text || ':confirmation')));
  perform pg_temp.acc3_store('purchase-evidence', r ->> 'objectPath');
  perform pg_temp.acc3_as(p_purchase, format('select public.purchase_evidence_finish(%L::uuid, true) as r', r ->> 'evidenceId'));
  perform pg_temp.acc3_as(p_purchase, format('select public.purchase_supplier_confirm(%L::uuid, 1, %L) as r', p_task, p_reference));
end;
$$;

-- A supplier-money file of p_kind on p_target, stored.
create or replace function pg_temp.acc3_money_file(p_actor uuid, p_kind text, p_target uuid) returns uuid
language plpgsql as $$
declare
  r jsonb;
begin
  r := pg_temp.acc3_as(p_actor, format('select public.supplier_money_evidence_begin(%L, %L::uuid, %L, %L, 2048, %L, %L::uuid) as r',
    p_kind, p_target, p_kind || '.pdf', 'application/pdf', pg_temp.acc3_sha(p_target::text || ':' || p_kind), gen_random_uuid()));
  perform pg_temp.acc3_store('supplier-money', r ->> 'objectPath');
  perform pg_temp.acc3_as(p_actor, format('select public.supplier_money_evidence_finish(%L::uuid, true) as r', r ->> 'evidenceId'));
  return (r ->> 'evidenceId')::uuid;
end;
$$;

-- Purchase asks for a deposit; Accounts approves and records it; the second Accounts person verifies it.
create or replace function pg_temp.acc3_supplier_paid(p_task uuid, p_amount bigint, p_reference text, p_purchase uuid,
  p_acc uuid, p_acc2 uuid) returns uuid
language plpgsql as $$
declare
  r jsonb;
  v_id uuid;
begin
  r := pg_temp.acc3_as(p_purchase, format('select public.supplier_payment_request_create(%L::uuid, %L::jsonb, %L::uuid) as r', p_task,
    jsonb_build_object('expectedCostVersionNo', 1, 'part', 'deposit', 'amountPaise', p_amount::text, 'dueDate', null, 'note', null,
      'proformaEvidenceId', pg_temp.acc3_money_file(p_purchase, 'proforma', p_task), 'askFunding', false),
    gen_random_uuid()));
  v_id := (r ->> 'id')::uuid;
  perform pg_temp.acc3_as(p_acc, format('select public.supplier_payment_decide(%L::uuid, %L, null, %s, %L::uuid) as r', v_id, 'approve',
    (select p.row_version from public.supplier_payment_requests p where p.id = v_id), gen_random_uuid()));
  perform pg_temp.acc3_as(p_acc, format('select public.supplier_payment_record(%L::uuid, %L::date, %L, %L, %L::uuid, %s, %L::uuid) as r',
    v_id, authz.finance_today(), 'bank_transfer', p_reference, pg_temp.acc3_money_file(p_acc, 'payment_proof', v_id),
    (select p.row_version from public.supplier_payment_requests p where p.id = v_id), gen_random_uuid()));
  perform pg_temp.acc3_as(p_acc2, format('select public.supplier_payment_verify(%L::uuid, %s, %L::uuid) as r', v_id,
    (select p.row_version from public.supplier_payment_requests p where p.id = v_id), gen_random_uuid()));
  return v_id;
end;
$$;

-- Build switches: service items on, the second Accounts person active. Returns what to restore.
create or replace function pg_temp.acc3_begin() returns jsonb
language plpgsql as $$
declare
  v_items boolean;
  v_acc2 text[];
begin
  select s.service_items_enabled into v_items from public.workflow_settings s where s.id;
  update public.workflow_settings set service_items_enabled = true where id and not service_items_enabled;
  select coalesce(array_agg(m.id::text), '{}') into v_acc2 from public.memberships m
  where m.user_id = 'a0000000-0000-4000-8000-000000000014' and m.role_code = 'accounts' and m.status = 'inactive';
  update public.memberships set status = 'active', deactivated_at = null where id::text = any (v_acc2);
  return jsonb_build_object('items', v_items, 'acc2', to_jsonb(v_acc2));
end;
$$;

create or replace function pg_temp.acc3_end(p_state jsonb) returns void
language plpgsql as $$
begin
  update public.memberships set status = 'inactive', deactivated_at = now()
  where id::text in (select jsonb_array_elements_text(p_state -> 'acc2'));
  update public.workflow_settings set service_items_enabled = (p_state ->> 'items')::boolean
  where id and service_items_enabled is distinct from (p_state ->> 'items')::boolean;
end;
$$;

-- SYNTHETIC FIXTURE STEP: the scenario Deal row (owner SQL, as synthetic_fixtures.sql).
create or replace function pg_temp.acc3_deal(p_id uuid, p_reference text, p_title text) returns boolean
language plpgsql as $$
begin
  if exists (select 1 from public.deals d where d.id = p_id) then
    return false;
  end if;
  insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id)
  select p_id, b.legal_entity_id, b.id, p_reference, p_title, 'a0000000-0000-4000-8000-000000000001'
  from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
  where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL';
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scenarios
-- ---------------------------------------------------------------------------

do $$
declare
  c_owner constant uuid := 'a0000000-0000-4000-8000-000000000001';  -- Sales Delhi A
  c_purchase constant uuid := 'a0000000-0000-4000-8000-000000000003'; -- Purchase Jodhpur
  c_manager constant uuid := 'a0000000-0000-4000-8000-000000000005'; -- Manager Delhi
  c_acc constant uuid := 'a0000000-0000-4000-8000-000000000006';     -- Accounts Jodhpur
  c_acc2 constant uuid := 'a0000000-0000-4000-8000-000000000014';    -- Accounts Jodhpur 2
  c_today date := authz.finance_today();
  v_state jsonb;
  v_entity uuid;
  v_version uuid;
  v_supplier uuid;
  v_hotel1 uuid;
  v_hotel2 uuid;
  v_task1 uuid;
  v_task2 uuid;
  r jsonb;
  hotel jsonb := '{"city": "Synthetic City", "rooms": 1, "adults": 2, "children": 0, "roomType": "Deluxe Room", "mealPlan": "Breakfast", "inclusions": null, "specialRequests": null}';
  trip jsonb := '{"destination": "Synthetic City, Rajasthan", "scope": "domestic"}';
begin
  select e.id into v_entity from public.legal_entities e where e.code = 'HOLIDAY_CHACHA';
  v_state := pg_temp.acc3_begin();

  -- d...0301 Hindi-language Deal (the preference is added by the next block).
  if pg_temp.acc3_deal('d0000000-0000-4000-8000-000000000301', 'SYN-ACC3-HINDI', 'Synthetic Phase 3 Hindi customer (Delhi)') then
    perform pg_temp.acc3_book('d0000000-0000-4000-8000-000000000301', c_owner,
      jsonb_build_array(jsonb_build_object('type', 'hotel', 'budget', '4000000', 'facts', hotel || jsonb_build_object(
        'hotelName', 'Synthetic Lake Hotel', 'checkIn', c_today + 30, 'checkOut', c_today + 33))),
      6000000, trip || jsonb_build_object('start', c_today + 30, 'end', c_today + 33),
      '{"contactName": "Synthetic Hindi Contact", "mobile": "6000000301", "email": "acc3.hindi@example.test", "contactConfirmed": true, "bookingFor": "individual", "payerDifferent": false, "payerName": null}',
      c_today + 20);
  end if;

  -- d...0302 booking contact without e-mail.
  if pg_temp.acc3_deal('d0000000-0000-4000-8000-000000000302', 'SYN-ACC3-NOMAIL', 'Synthetic Phase 3 contact without e-mail (Delhi)') then
    perform pg_temp.acc3_book('d0000000-0000-4000-8000-000000000302', c_owner,
      jsonb_build_array(jsonb_build_object('type', 'hotel', 'budget', '4000000', 'facts', hotel || jsonb_build_object(
        'hotelName', 'Synthetic Lake Hotel', 'checkIn', c_today + 40, 'checkOut', c_today + 42))),
      5000000, trip || jsonb_build_object('start', c_today + 40, 'end', c_today + 42),
      '{"contactName": "Synthetic Mobile Only Contact", "mobile": "6000000302", "email": null, "contactConfirmed": true, "bookingFor": "individual", "payerDifferent": false, "payerName": null}',
      c_today + 30);
  end if;

  -- d...0303 committed Deal: two confirmed hotels and a paid, verified supplier payment.
  if pg_temp.acc3_deal('d0000000-0000-4000-8000-000000000303', 'SYN-ACC3-HOTELS', 'Synthetic Phase 3 two hotels, supplier paid (Delhi)') then
    -- SYNTHETIC FIXTURE STEP: catalogue hotels (owner SQL, the acc2-support pattern); the rate sheet names them.
    insert into public.hotel_catalogue (legal_entity_id, name, city, source_ref, created_by, updated_by)
    select v_entity, h.name, 'Synthetic City', h.ref, 'a0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000007'
    from (values ('SYN Acc3 Lake Hotel', 'SYN-ACC3-H-001'), ('SYN Acc3 Fort Hotel', 'SYN-ACC3-H-002')) as h (name, ref)
    where not exists (select 1 from public.hotel_catalogue x where x.legal_entity_id = v_entity and x.source_ref = h.ref);
    select id into v_hotel1 from public.hotel_catalogue where legal_entity_id = v_entity and source_ref = 'SYN-ACC3-H-001';
    select id into v_hotel2 from public.hotel_catalogue where legal_entity_id = v_entity and source_ref = 'SYN-ACC3-H-002';

    v_version := pg_temp.acc3_book('d0000000-0000-4000-8000-000000000303', c_owner,
      jsonb_build_array(
        jsonb_build_object('type', 'hotel', 'budget', '4000000', 'facts', hotel || jsonb_build_object(
          'hotelName', 'SYN Acc3 Lake Hotel', 'checkIn', c_today + 45, 'checkOut', c_today + 48)),
        jsonb_build_object('type', 'hotel', 'budget', '3500000', 'facts', hotel || jsonb_build_object(
          'hotelName', 'SYN Acc3 Fort Hotel', 'checkIn', c_today + 48, 'checkOut', c_today + 50))),
      9000000, trip || jsonb_build_object('start', c_today + 45, 'end', c_today + 50),
      '{"contactName": "Synthetic Two Hotels Contact", "mobile": "6000000303", "email": "acc3.hotels@example.test", "contactConfirmed": true, "bookingFor": "individual", "payerDifferent": false, "payerName": null}',
      c_today + 25);
    perform pg_temp.acc3_approve('d0000000-0000-4000-8000-000000000303', v_version, c_acc);
    perform pg_temp.acc3_receipt('d0000000-0000-4000-8000-000000000303', 2000000, 'UTRSYNACC30303', c_acc, c_acc2);

    -- Supplier with bank details approved by the branch Manager.
    select s.id into v_supplier from public.suppliers s where s.legal_entity_id = v_entity and s.name = 'SYN Acc3 Stays';
    if v_supplier is null then
      r := pg_temp.acc3_as(c_purchase, format('select public.supplier_create(%L::uuid, %L::jsonb) as r', v_entity,
        '{"name": "SYN Acc3 Stays", "serviceTypes": ["hotel"], "city": "Synthetic City", "contactName": null, "contactPhone": null, "contactEmail": "desk.acc3@example.test", "paymentTerms": null, "supplierKind": "direct"}'));
      v_supplier := (r ->> 'supplierId')::uuid;
      r := pg_temp.acc3_as(c_purchase, format('select public.supplier_add_beneficiary(%L::uuid, %L::uuid, %L::jsonb) as r', v_supplier, gen_random_uuid(),
        '{"accountHolder": "SYN Acc3 Stays", "bankName": "Synthetic Bank", "ifsc": "SYNB0000001", "accountNumber": "000033334444"}'));
      perform pg_temp.acc3_as(c_manager, format('select public.supplier_approve_beneficiary(%L::uuid, %s) as r', v_supplier, r ->> 'revisionNo'));
    end if;

    select t.id into v_task1 from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.deal_id = 'd0000000-0000-4000-8000-000000000303' order by i.item_no limit 1;
    select t.id into v_task2 from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.deal_id = 'd0000000-0000-4000-8000-000000000303' order by i.item_no offset 1 limit 1;
    perform pg_temp.acc3_hotel_confirmed(v_task1, v_supplier, v_hotel1, 'SYN Acc3 Lake Hotel', 3000000, 'SYN-CONF-ACC3-1', c_purchase, c_acc);
    perform pg_temp.acc3_hotel_confirmed(v_task2, v_supplier, v_hotel2, 'SYN Acc3 Fort Hotel', 2500000, 'SYN-CONF-ACC3-2', c_purchase, c_acc);
    -- The supplier sells both hotels (the rate sheet needs active links).
    if not exists (select 1 from public.supplier_hotels l where l.supplier_id = v_supplier and l.hotel_id = v_hotel1 and l.status = 'active') then
      perform pg_temp.acc3_as(c_purchase, format('select public.supplier_hotel_link(%L::uuid, %L::uuid, %L::uuid) as r', v_supplier, v_hotel1, gen_random_uuid()));
    end if;
    if not exists (select 1 from public.supplier_hotels l where l.supplier_id = v_supplier and l.hotel_id = v_hotel2 and l.status = 'active') then
      perform pg_temp.acc3_as(c_purchase, format('select public.supplier_hotel_link(%L::uuid, %L::uuid, %L::uuid) as r', v_supplier, v_hotel2, gen_random_uuid()));
    end if;
    perform pg_temp.acc3_supplier_paid(v_task1, 900000, 'SYNACC3PAY0303', c_purchase, c_acc, c_acc2);
  end if;

  -- d...0304 trip ended with a Rs 3 balance.
  if pg_temp.acc3_deal('d0000000-0000-4000-8000-000000000304', 'SYN-ACC3-BAL3', 'Synthetic Phase 3 trip ended, Rs 3 balance (Delhi)') then
    v_version := pg_temp.acc3_book('d0000000-0000-4000-8000-000000000304', c_owner,
      jsonb_build_array(jsonb_build_object('type', 'hotel', 'budget', '4000000', 'facts', hotel || jsonb_build_object(
        'hotelName', 'Synthetic Lake Hotel', 'checkIn', c_today - 12, 'checkOut', c_today - 8))),
      1000300, trip || jsonb_build_object('start', c_today - 12, 'end', c_today - 8),
      '{"contactName": "Synthetic Small Balance Contact", "mobile": "6000000304", "email": "acc3.balance@example.test", "contactConfirmed": true, "bookingFor": "individual", "payerDifferent": false, "payerName": null}',
      c_today - 20);
    perform pg_temp.acc3_approve('d0000000-0000-4000-8000-000000000304', v_version, c_acc);
    perform pg_temp.acc3_receipt('d0000000-0000-4000-8000-000000000304', 1000000, 'UTRSYNACC30304', c_acc, c_acc2);
  end if;

  perform pg_temp.acc3_end(v_state);
end;
$$;

-- Hindi preference (contract 5.3, table of migration 20261205000110). Through
-- deal_message_prefs_set (20261205000120) as the Sales owner when it exists;
-- owner SQL when only the table exists; skipped (with a notice) before the
-- table exists. A later load adds it.
do $$
declare
  c_deal constant uuid := 'd0000000-0000-4000-8000-000000000301';
  v_exists boolean;
begin
  if not exists (select 1 from public.deals d where d.id = c_deal) then
    return;
  end if;
  if to_regclass('public.deal_message_prefs') is null then
    raise notice 'acc3 fixture: deal_message_prefs does not exist yet; Hindi preference of SYN-ACC3-HINDI skipped';
    return;
  end if;
  execute 'select exists (select 1 from public.deal_message_prefs p where p.deal_id = $1)' into v_exists using c_deal;
  if v_exists then
    return;
  end if;
  if to_regprocedure('public.deal_message_prefs_set(uuid, integer, jsonb, uuid)') is not null then
    perform pg_temp.acc3_as('a0000000-0000-4000-8000-000000000001',
      format('select public.deal_message_prefs_set(%L::uuid, 0, %L::jsonb, %L::uuid) as r', c_deal, '{"language": "hi"}', gen_random_uuid()));
  else
    execute $sql$
      insert into public.deal_message_prefs (deal_id, legal_entity_id, branch_id, language, updated_by)
      select d.id, d.legal_entity_id, d.branch_id, 'hi', d.owner_user_id from public.deals d where d.id = $1
    $sql$ using c_deal;
  end if;
end;
$$;
