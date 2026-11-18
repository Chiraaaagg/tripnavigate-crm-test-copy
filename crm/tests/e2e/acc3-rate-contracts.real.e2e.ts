import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  ROUTES, USERS, type UserKey, allowedOutbound, approveBooking, asUser, bookingWithTrip, configured, dayFromToday, entityId, freshDeal, prepareUsers, q,
  restoreSwitches3, saveSwitches3, session, sha, stamp, switchesOn3,
} from './acc3-real-support';

/**
 * Accounts Phase 3 test plan 16.4, journey 6 (rate contracts, 9.1-9.5),
 * Track T, written from the contract: a rate sheet imported → draft
 * contracts → Manager approves → the Purchase offer form shows the contract
 * rate across two seasons → a different rate needs a reason → the Manager
 * sees "differs from contract" before approving the cost.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');
test.setTimeout(10 * 60_000);
test.use({ actionTimeout: 30_000 });

let secrets: Record<UserKey, string>;
test.beforeAll(async () => {
  await saveSwitches3();
  secrets = await prepareUsers();
  await switchesOn3({ rateContracts: true });
});
test.afterAll(async () => {
  await restoreSwitches3();
});

test('6. rate contracts: sheet → drafts → Manager approves → contract rate across two seasons → "Differs from contract" with a reason', async ({ browser }) => {
  const e = await entityId();
  // SYNTHETIC FIXTURE STEP: a hotel supplier with a source reference, a catalogue hotel and the active supplier-hotel link
  // (Phase 2 supplier master tables; owner SQL so the journey does not depend on the supplier screens).
  const supplierRef = `SYN-RC-S-${stamp}`;
  const hotelRef = `SYN-RC-H-${stamp}`;
  const supplierId = (await q<{ id: string }>(`insert into public.suppliers (legal_entity_id, name, service_types, city, contact_email, supplier_kind, source_ref,
    created_by, updated_by) values ($1, $2, array['hotel'], 'Synthetic City', 'rates@example.test', 'direct', $3, $4, $4) returning id`,
  [e, `E2E Rate Stays ${stamp}`, supplierRef, USERS.purchase.id]))[0]!.id;
  const hotelId = (await q<{ id: string }>(`insert into public.hotel_catalogue (legal_entity_id, name, city, source_ref, created_by, updated_by)
    values ($1, $2, 'Synthetic City', $3, $4, $4) returning id`, [e, `E2E Rate Hotel ${stamp}`, hotelRef, USERS.purchase.id]))[0]!.id;
  await q(`insert into public.supplier_hotels (legal_entity_id, supplier_id, hotel_id, source, created_by) values ($1, $2, $3, 'manual', $4)`,
    [e, supplierId, hotelId, USERS.purchase.id]);

  // Rate sheet (9.4 columns): season 1 ends tomorrow+2, season 2 starts the day after; weekend rate on season 2.
  const from = dayFromToday(0);
  const to = dayFromToday(200);
  const s1End = dayFromToday(12);
  const s2Start = dayFromToday(13);
  const row = (season: 1 | 2, meal: string, rate: string, weekend: string | null) => ({ supplierRef, hotelRef, validFrom: from, validTo: to,
    seasonFrom: season === 1 ? from : s2Start, seasonTo: season === 1 ? s1End : to, roomType: 'Deluxe Room', mealPlan: meal, rate, weekendRate: weekend,
    extraAdult: '1500', childWithBed: '1000', childWithoutBed: null, blackoutDates: null, cancellationTerms: 'Synthetic: free cancellation up to 7 days before' });
  const rows = [row(1, 'CP', '4000', null), row(2, 'CP', '5000', '6000'), row(1, 'Breakfast and dinner', '5500', null), row(2, 'MAP', '6500', null)];
  // ASSUMPTION: the rate sheet goes through the Phase 2 import commands (stage, validate, apply with the proposal hash).
  const staged = await asUser<{ batchId: string }>(USERS.purchase.id,
    'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, $7) as r', [e, 'rate_sheet', null, 'synthetic rate sheet.csv', sha(), JSON.stringify(rows),
      randomUUID()]);
  // import_batch_validate returns the summary itself; the rate-sheet counts sit under rateSheet (migration 20261205000530 header).
  const dry = await asUser<{ rateSheet: Record<string, unknown>; proposalHash: string; invalid: number }>(USERS.purchase.id,
    'select public.import_batch_validate($1) as r', [staged.batchId]);
  expect(dry.rateSheet).toMatchObject({ contracts: 1, lines: 4, invalidRows: 0 });
  const batch = (await q<{ row_version: number }>('select row_version from public.import_batches where id = $1', [staged.batchId]))[0]!;
  await asUser(USERS.purchase.id, 'select public.import_batch_apply($1, $2, $3, $4) as r', [staged.batchId, batch.row_version,
    'Synthetic: owner rate sheet for the season', dry.proposalHash]);
  const [contract] = await q<{ id: string; status: string; contract_no: string; source: string; row_version: number }>(
    `select id, status, contract_no, source, row_version from public.rate_contracts where supplier_id = $1 and hotel_id = $2`, [supplierId, hotelId]);
  expect(contract).toMatchObject({ status: 'draft', source: 'import' });
  expect(contract!.contract_no).toMatch(/^RC-[0-9]{4}-[0-9]{6}$/);

  // Purchase submits; the Manager approves in Approvals › Rate contracts (not the enterer).
  const pur = await session(browser, 'purchase', secrets);
  await pur.page.goto(ROUTES.rateContracts);
  await expect(pur.page.getByText(contract!.contract_no).first()).toBeVisible();
  await asUser(USERS.purchase.id, 'select public.rate_contract_submit($1, $2, $3) as r', [contract!.id, contract!.row_version, randomUUID()]);
  const mgr = await session(browser, 'manager', secrets);
  await mgr.page.goto(ROUTES.approvals);
  await expect(mgr.page.getByText(contract!.contract_no).first()).toBeVisible();
  const rv = (await q<{ v: number }>('select row_version as v from public.rate_contracts where id = $1', [contract!.id]))[0]!.v;
  await asUser(USERS.manager.id, 'select public.rate_contract_decide($1, $2, $3, $4, $5) as r', [contract!.id, 'approve', null, rv, randomUUID()]);
  expect((await q<{ s: string }>('select status as s from public.rate_contracts where id = $1', [contract!.id]))[0]!.s).toBe('active');

  // ASSUMPTION: the hotel facts carry the catalogue hotel as `catalogueHotelId` (contract E9 "a hotel task with a catalogue hotel").
  // A hotel booking whose stay crosses the season boundary (nights 10..15: three in season 1, three in season 2), 2 rooms.
  const dealId = await freshDeal(`ACC3RC-${stamp}`);
  const v = await bookingWithTrip(dealId, 10, 16, 61, { items: [['hotel', { hotelName: `E2E Rate Hotel ${stamp}`, city: 'Synthetic City',
    checkIn: dayFromToday(10), checkOut: dayFromToday(16), rooms: 2, adults: 2, roomType: 'Deluxe Room', mealPlan: 'Breakfast', children: 0, inclusions: null,
    specialRequests: null, catalogueHotelId: hotelId }]], budget: '1000000' });
  await approveBooking(dealId, v.versionId);
  const [task] = await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase'`, [dealId]);
  await asUser(USERS.purchase.id, 'select public.purchase_task_claim($1) as r', [task!.id]);
  const roomType = (await q<{ id: string }>(`select id from public.hotel_room_types where hotel_id = $1 and name = 'Deluxe Room' and status = 'active'`, [hotelId]))[0]!.id;
  const look = await asUser<{ state: string; nights: Array<{ ratePaise: string; weekend: boolean }>; perRoomTotalPaise: string; totalPaise: string }>(
    USERS.purchase.id, 'select public.rate_contract_lookup($1, $2, $3, $4, $5) as r', [task!.id, supplierId, hotelId, roomType, 'CP']);
  expect(look.state).toBe('ok');
  expect(look.nights.length).toBe(6);
  const expected = look.nights.reduce((s, n) => s + BigInt(n.ratePaise), 0n);
  expect(BigInt(look.perRoomTotalPaise)).toBe(expected);
  expect(BigInt(look.totalPaise)).toBe(expected * 2n);
  expect(new Set(look.nights.map((n) => n.ratePaise)).size).toBeGreaterThan(1);

  // Purchase offer form: room type and meal plan pick-lists, "Contract rate ₹X for these dates"; a different rate needs a reason.
  await pur.page.goto(ROUTES.purchaseTask(task!.id));
  const form = pur.page.getByRole('form', { name: 'Add a rate' });
  await form.getByLabel('Supplier', { exact: true }).selectOption({ label: `E2E Rate Stays ${stamp}` });
  await form.getByLabel('Room type').selectOption({ label: 'Deluxe Room' });
  await form.getByLabel('Meal plan').selectOption('CP');
  await expect(form.getByText(/^Contract rate ₹/)).toBeVisible();
  await form.getByLabel('Amount for the whole stay (₹)').fill(String((BigInt(look.totalPaise) + 100000n) / 100n));
  await expect(form.getByText(/^Differs from contract/)).toBeVisible();
  await expect(form.getByLabel('Why is this different from the contract?')).toBeVisible();
  const quoteRefused = await asUser(USERS.purchase.id, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task!.id, randomUUID(), JSON.stringify({
    supplierId, hotelName: `E2E Rate Hotel ${stamp}`, roomType: 'Deluxe Room', mealPlan: 'Breakfast', quotedCostPaise: String(BigInt(look.totalPaise) + 100000n),
    holdUntil: null, cancellationTerms: null, catalogueHotelId: hotelId, roomTypeId: roomType, mealPlanCode: 'CP' })]).then(() => null, (err: { message: string; hint?: string }) => err);
  expect(quoteRefused).toMatchObject({ message: 'invalid_input' });
  expect(quoteRefused!.hint ?? '').toMatch(/contractDeviationReason/);
  const differs = await asUser<{ quoteId: string }>(USERS.purchase.id, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task!.id, randomUUID(),
    JSON.stringify({ supplierId, hotelName: `E2E Rate Hotel ${stamp}`, roomType: 'Deluxe Room', mealPlan: 'Breakfast',
      quotedCostPaise: String(BigInt(look.totalPaise) + 100000n), holdUntil: null, cancellationTerms: null, catalogueHotelId: hotelId, roomTypeId: roomType, mealPlanCode: 'CP',
      contractDeviationReason: 'Synthetic: festival surcharge on two nights' })]);
  expect((await q<{ contract_state: string; contract_total_paise: string }>(
    'select contract_state, contract_total_paise::text from public.purchase_quotes where id = $1', [differs.quoteId]))[0]).toMatchObject({
    contract_state: 'differs', contract_total_paise: look.totalPaise });
  const matches = await asUser<{ quoteId: string }>(USERS.purchase.id, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task!.id, randomUUID(),
    JSON.stringify({ supplierId, hotelName: `E2E Rate Hotel ${stamp}`, roomType: 'Deluxe Room', mealPlan: 'Breakfast', quotedCostPaise: look.totalPaise,
      holdUntil: null, cancellationTerms: null, catalogueHotelId: hotelId, roomTypeId: roomType, mealPlanCode: 'CP' })]);
  expect((await q<{ s: string }>('select contract_state as s from public.purchase_quotes where id = $1', [matches.quoteId]))[0]!.s).toBe('matches');

  // Over-budget cost on the differing quote: the Manager sees "differs from contract" before approving.
  await asUser(USERS.purchase.id, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r', [task!.id, differs.quoteId, 0,
    String(BigInt(look.totalPaise) + 100000n), null, null, randomUUID()]);
  // Budget ₹10,000 < the cost: the cost waits for a Manager (over budget).
  expect((await q<{ n: number }>(`select count(*)::int as n from public.purchase_cost_versions where task_id = $1 and stage = 'proposed'`, [task!.id]))[0]!.n)
    .toBeGreaterThan(0);
  // Sales and Flight never see contract rates (fence 14).
  expect(await asUser(USERS.sales.id, 'select public.rate_contract_get($1) as r', [contract!.id])).toBeNull();
  expect(await asUser(USERS.flight.id, 'select public.rate_contracts_list($1::jsonb, $2, $3) as r', [JSON.stringify({}), null, 50])).toBeNull();
  // The Manager's read carries the flags (9.3: sm_manager_cost_rows → manager_approvals) …
  const approvals = await asUser<{ costsAboveBudget: Array<{ taskId: string; contractState?: string; contractTotalPaise?: string | null;
    contractDeviationReason?: string | null }> }>(USERS.manager.id, 'select public.manager_approvals() as r');
  expect(approvals.costsAboveBudget.find((c) => c.taskId === task!.id)).toMatchObject({ contractState: 'differs', contractTotalPaise: look.totalPaise,
    contractDeviationReason: 'Synthetic: festival surcharge on two nights' });
  // … and the Approvals screen shows "Differs from contract" on that cost before approving (16.4 item 6).
  await mgr.page.goto(ROUTES.approvals);
  const card = mgr.page.getByRole('article', { name: new RegExp(`E2E Rate Hotel ${stamp}`) });
  await expect(card).toBeVisible();
  await expect(card.getByText(/[Dd]iffers from contract/).first()).toBeVisible();
  // The contract total and Purchase's reason, in plain words, before the Approve button.
  const rupees = (BigInt(look.totalPaise) / 100n).toLocaleString('en-IN');
  await expect(card.getByText(`The rate contract total for this stay is ₹${rupees}`, { exact: false })).toBeVisible();
  await expect(card.getByText('Purchase’s reason: Synthetic: festival surcharge on two nights')).toBeVisible();
  await Promise.all([pur.ctx.close(), mgr.ctx.close()]);
});

test('9. no outbound request except the app and the local Supabase', () => {
  expect(allowedOutbound()).toEqual([]);
});
