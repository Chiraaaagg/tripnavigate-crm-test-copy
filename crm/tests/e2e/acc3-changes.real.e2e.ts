import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  HOTEL, ROUTES, USERS, type UserKey, allLiveOff, allowedOutbound, approveBooking, asUser, bookingWithTrip, configured, dayFromToday, documentsOf, freshDeal,
  messagesOf, messagesOn, prepareUsers, purchaseFile, q, restoreSwitches3, saveSwitches3, session, stamp, supplierConfirmedHotel, switchesOn3,
  verifiedCash,
} from './acc3-real-support';

/**
 * Accounts Phase 3 test plan 16.4, journeys 7 (change after a supplier
 * confirmed, 10.1-10.5) and 8 (add and remove services, 11.1-11.3), Track T,
 * written from the contract. Addendum O2 order for every kind: the Sales
 * owner creates the request (status draft), fills the change version and
 * sends it (requested); the branch Manager approves exactly that version (the
 * only approval, LD24 / O1); for a change after confirmation Purchase then
 * reconfirms with the same supplier; the old confirmation stays valid until
 * the change is applied. The "booking changed" message row (event cr:<id>)
 * is checked once per channel (skipped test_deal on the synthetic Deal: see
 * the CONTRACT GAP note at that step).
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');
test.setTimeout(20 * 60_000);
test.use({ actionTimeout: 30_000 });

let secrets: Record<UserKey, string>;
test.beforeAll(async () => {
  await saveSwitches3();
  secrets = await prepareUsers();
  await switchesOn3({ autoBills: true, release: true, changes: true, serviceChanges: true });
});
test.afterAll(async () => {
  await allLiveOff();
  await restoreSwitches3();
});

type Cr = { changeRequestId?: string; id?: string; refNo?: string };
const crId = (r: Cr) => r.changeRequestId ?? r.id!;
const crRow = async (id: string) => (await q<{ status: string; row_version: number; ref_no: string; change_version_id: string | null; removal_route: string | null }>(
  'select status, row_version, ref_no, change_version_id, removal_route from public.booking_change_requests where id = $1', [id]))[0]!;
const rvOf = async (versionId: string) => (await q<{ v: number }>('select row_version as v from public.booking_versions where id = $1', [versionId]))[0]!.v;
async function request(dealId: string, kind: string, itemIds: string[], extra: Record<string, unknown> = {}) {
  return crId(await asUser<Cr>(USERS.sales.id, 'select public.booking_change_request_create($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({ kind, itemIds,
    changeSummary: 'Synthetic: check-in one day later, same hotel', reason: 'Synthetic: the customer changed the travel dates', ...extra }), randomUUID()]));
}
async function approve(id: string) {
  await asUser(USERS.manager.id, 'select public.booking_change_request_decide($1, $2, $3, $4, $5) as r', [id, 'approve', null, (await crRow(id)).row_version,
    randomUUID()]);
}
async function openVersion(id: string): Promise<string> {
  const opened = await asUser<{ versionId: string }>(USERS.sales.id, 'select public.booking_change_open_version($1, $2) as r', [id, randomUUID()]);
  return opened.versionId;
}
async function submit(id: string, versionId: string, changedItemIds: string[]) {
  const ready = await asUser<{ issues: string[]; contentHash: string }>(USERS.sales.id, 'select public.booking_readiness($1) as r', [versionId]);
  expect(ready.issues).toEqual([]);
  return asUser(USERS.sales.id, 'select public.booking_change_submit($1, $2, $3::uuid[], $4) as r', [id, ready.contentHash, changedItemIds, randomUUID()]);
}
const reconOf = async (id: string) => q<{ id: string; status: string; row_version: number; over_budget: boolean; task_id: string }>(
  'select id, status, row_version, over_budget, task_id from public.task_reconfirmations where change_request_id = $1 order by task_id', [id]);
const snapshot = async (dealId: string, taskId: string) => ({
  task: (await q('select status, supplier_reference, supplier_confirmed_at from public.fulfilment_tasks where id = $1', [taskId]))[0],
  costs: await q('select version_no, stage, amount_paise::text from public.purchase_cost_versions where task_id = $1 order by version_no', [taskId]),
  confirmations: await q('select confirmation_no, supplier_reference from public.task_confirmations where task_id = $1 order by confirmation_no', [taskId]),
  versions: await q('select version_no, status from public.booking_versions where deal_id = $1 order by version_no', [dealId]),
  dues: await asUser(USERS.accA.id, 'select public.deal_dues($1) as r', [dealId]),
  documents: (await documentsOf(dealId)).map((d) => `${d.kind}:${d.status}:${d.number ?? ''}`),
});

test('7. change after confirmation: request → Manager approves → Sales edits → Purchase reconfirms above budget → Manager approves the cost → applied; supplier refuses → nothing changed', async ({ browser }) => {
  const ref = `ACC3CH-${stamp}`;
  const dealId = await freshDeal(ref);
  await messagesOn([dealId]);
  const v = await bookingWithTrip(dealId, 30, 33, 71, { budget: '400000' });
  await approveBooking(dealId, v.versionId);
  await verifiedCash(dealId, '1000000', 71);
  const hotel = await supplierConfirmedHotel(dealId, '300000');
  // The released Invoice (automatic bills on).
  await expect.poll(async () => (await documentsOf(dealId)).some((d) => d.kind === 'invoice' && d.status === 'released'), { timeout: 30_000 }).toBe(true);

  // Sales owner asks on the Deal page ("Request a change"); the Manager approves (the only approval).
  const so = await session(browser, 'sales', secrets);
  await so.page.goto(ROUTES.deal(dealId, 'services'));
  await expect(so.page.getByRole('button', { name: 'Request a change' }).first()).toBeVisible();
  const id = await request(dealId, 'change', [v.itemIds[0]!]);
  expect((await crRow(id)).status).toBe('draft');
  await so.page.goto(ROUTES.deal(dealId, 'services'));
  await expect(so.page.getByRole('button', { name: /^Start the change in the booking for / }).first()).toBeVisible();

  // O2: Sales fills the change version (booking form in change mode) and sends it.
  const changeVersion = await openVersion(id);
  await asUser(USERS.sales.id, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r', [v.itemIds[0], changeVersion, await rvOf(changeVersion),
    JSON.stringify({ ...HOTEL, checkIn: dayFromToday(31), checkOut: dayFromToday(34) }), '400000']);
  await so.page.goto(ROUTES.deal(dealId, 'services'));
  await expect(so.page.getByRole('link', { name: 'Fill in and send the change' }).first()).toBeVisible();
  await submit(id, changeVersion, [v.itemIds[0]!]);
  expect((await crRow(id)).status).toBe('requested');
  expect(await reconOf(id)).toEqual([]);
  // The Manager approves exactly the version sent (the only approval).
  const mgr = await session(browser, 'manager', secrets);
  await mgr.page.goto(ROUTES.approvals);
  await expect(mgr.page.getByText((await crRow(id)).ref_no).first()).toBeVisible();
  await approve(id);
  expect((await crRow(id)).status).toBe('approved');
  const [recon] = await reconOf(id);
  expect(recon).toMatchObject({ status: 'pending', task_id: hotel.taskId });
  // Old confirmation still valid while waiting: a new supplier payment request is refused change_in_progress (no further steps here).

  // Purchase reconfirms above budget (new rate ₹4,500 + fee ₹200 > budget ₹4,000) with the supplier's new confirmation.
  const pur = await session(browser, 'purchase', secrets);
  await pur.page.goto(ROUTES.purchaseTask(hotel.taskId));
  await expect(pur.page.getByText(/Reconfirm with supplier/).first()).toBeVisible();
  const proof = await purchaseFile(hotel.taskId, 'supplier_confirmation');
  await asUser(USERS.purchase.id, 'select public.task_reconfirm_record($1, $2, $3::jsonb, $4) as r', [recon!.id, recon!.row_version, JSON.stringify({
    newRatePaise: '450000', supplierFeePaise: '20000', newReference: `SYN-RECONF-${stamp}`, evidenceId: proof, note: null }), randomUUID()]);
  const [recorded] = await reconOf(id);
  expect(recorded).toMatchObject({ status: 'recorded', over_budget: true });
  // Notice 19 (widened) to the approvers; the Manager approves the cost → applied.
  await asUser(USERS.manager.id, 'select public.task_reconfirm_approve_over_budget($1, $2, $3) as r', [recorded!.id, recorded!.row_version, randomUUID()]);
  expect((await crRow(id)).status).toBe('applied');
  const changed = await messagesOf(dealId, 'booking_changed');

  // After apply: base superseded, review approved by the change request, history side by side, cost history with two committed rows.
  const versions = await q<{ id: string; status: string; change_request_id: string | null }>(
    'select id, status, change_request_id from public.booking_versions where deal_id = $1 order by version_no', [dealId]);
  expect(versions.find((x) => x.id === v.versionId)!.status).toBe('superseded');
  expect(versions.at(-1)).toMatchObject({ id: changeVersion, change_request_id: id });
  expect((await q<{ status: string; approval_source: string }>('select status, approval_source from public.accounts_booking_reviews where booking_version_id = $1',
    [changeVersion]))[0]).toMatchObject({ status: 'approved', approval_source: 'change_request' });
  expect(await q('select confirmation_no, supplier_reference from public.task_confirmations where task_id = $1 order by confirmation_no', [hotel.taskId]))
    .toEqual([{ confirmation_no: 1, supplier_reference: `SYN-CONF-${stamp}` }, { confirmation_no: 2, supplier_reference: `SYN-RECONF-${stamp}` }]);
  const committed = await q<{ amount_paise: string; confirmation_no: number }>(
    `select amount_paise::text, confirmation_no from public.purchase_cost_versions where task_id = $1 and stage = 'committed' order by confirmation_no`, [hotel.taskId]);
  expect(committed.map((x) => x.confirmation_no)).toEqual([1, 2]);
  expect(committed[1]!.amount_paise).toBe('470000');
  await so.page.goto(ROUTES.deal(dealId, 'services'));
  await expect(so.page.getByText('History of changes').first()).toBeVisible();
  // Dues follow the new version (approved by the change request).
  const dues = await asUser<{ basis: { versionNo: number } }>(USERS.accA.id, 'select public.deal_dues($1) as r', [dealId]);
  expect(dues.basis.versionNo).toBe(2);
  // Replacement bill drafted (and released while automatic release is On); the old one stays released until then.
  await expect.poll(async () => (await documentsOf(dealId)).filter((d) => d.kind === 'invoice').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  expect((await documentsOf(dealId)).some((d) => d.auto_rule === 'inv_replace_on_change')).toBe(true);
  // Customer "booking changed" message once per channel (event key cr:<id>).
  // CONTRACT GAP (reported): apply drafts the replacement bill only on a synthetic Deal in the 'test' environment (finance gate in
  // authz.cdoc_auto_run) while 5.5 skips a synthetic Deal's message `test_deal` — one Deal cannot show both. The bill is checked
  // above; the message row proves the event, its key and "once" (not its sending, which journey 2 covers).
  expect(changed.map((m) => `${m.channel}:${m.event_key}:${m.skip_reason}`).sort()).toEqual([`email:cr:${id}:test_deal`, `whatsapp:cr:${id}:test_deal`]);
  // Accounts gets the urgent "booking changed" notice (widened kind 3).
  expect((await q<{ r: string }>(`select recipient_user_id as r from public.staff_notices where kind = 'booking_changed' and deal_id = $1`, [dealId])).map((x) => x.r))
    .toEqual(expect.arrayContaining([USERS.accA.id]));

  // Second run: the supplier refuses → nothing changed.
  const ref2 = `ACC3CN-${stamp}`;
  const deal2 = await freshDeal(ref2);
  const v2 = await bookingWithTrip(deal2, 30, 33, 72, { budget: '400000' });
  await approveBooking(deal2, v2.versionId);
  const hotel2 = await supplierConfirmedHotel(deal2, '300000');
  await expect.poll(async () => (await documentsOf(deal2)).some((d) => d.kind === 'invoice' && d.status === 'released'), { timeout: 30_000 }).toBe(true);
  const before = await snapshot(deal2, hotel2.taskId);
  const id2 = await request(deal2, 'change', [v2.itemIds[0]!]);
  const cv2 = await openVersion(id2);
  await asUser(USERS.sales.id, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r', [v2.itemIds[0], cv2, await rvOf(cv2),
    JSON.stringify({ ...HOTEL, checkIn: dayFromToday(31), checkOut: dayFromToday(34) }), '400000']);
  await submit(id2, cv2, [v2.itemIds[0]!]);
  await approve(id2);
  const [r2] = await reconOf(id2);
  await pur.page.goto(ROUTES.purchaseTask(hotel2.taskId));
  await expect(pur.page.getByRole('button', { name: /Supplier refused/ }).first()).toBeVisible();
  await asUser(USERS.purchase.id, 'select public.task_reconfirm_refuse($1, $2, $3, $4) as r', [r2!.id, r2!.row_version,
    'Synthetic: the hotel has no rooms on the new dates', randomUUID()]);
  expect((await crRow(id2)).status).toBe('not_possible');
  const after = await snapshot(deal2, hotel2.taskId);
  // The discarded change version is not part of the comparison (only confirmed / superseded versions).
  const keep = (s: typeof before) => ({ ...s, versions: (s.versions as Array<{ status: string }>).filter((x) => x.status !== 'discarded') });
  expect(keep(after)).toEqual(keep(before));
  // Notice 54 to the requester and SO*: "the earlier booking stands".
  expect((await q<{ n: number }>(`select count(*)::int as n from public.staff_notices where kind = 'change_not_possible' and deal_id = $1`, [deal2]))[0]!.n)
    .toBeGreaterThan(0);
  await Promise.all([so.ctx.close(), mgr.ctx.close(), pur.ctx.close()]);
});

test('8. add and remove: add a transfer → new task; remove an unbooked activity → withdrawn; remove a booked hotel → charges → Manager approves → cancelled → overpayment refund', async ({ browser }) => {
  const ref = `ACC3AR-${stamp}`;
  const dealId = await freshDeal(ref);
  const activity = { name: 'Synthetic city walk', city: 'Synthetic City', date: dayFromToday(31), participants: 2, time: null, notes: null };
  const v = await bookingWithTrip(dealId, 30, 33, 81, { items: [['hotel', { ...HOTEL, checkIn: dayFromToday(30), checkOut: dayFromToday(33) }],
    ['activity', activity]], selling: '2000000' });
  await approveBooking(dealId, v.versionId);
  await verifiedCash(dealId, '2000000', 81);
  const hotel = await supplierConfirmedHotel(dealId, '300000');
  const [hotelItem, activityItem] = v.itemIds;
  const tasksBefore = await q<{ id: string; department: string }>('select id, department from public.fulfilment_tasks where deal_id = $1', [dealId]);

  // Add a transfer ("Add a service"): Manager approves; Sales adds it in the change version with the new total and plan; applied → one new task.
  const so = await session(browser, 'sales', secrets);
  await so.page.goto(ROUTES.deal(dealId, 'services'));
  await expect(so.page.getByRole('button', { name: 'Add a service' }).first()).toBeVisible();
  const add = await request(dealId, 'add_service', [], { changeSummary: 'Synthetic: add an airport transfer' });
  const cvAdd = await openVersion(add);
  const added = await asUser<{ itemId: string; rowVersion: number }>(USERS.sales.id,
    'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r', [cvAdd, await rvOf(cvAdd), 'transfer', JSON.stringify({
      route: 'Synthetic airport to hotel', date: dayFromToday(30), vehicleType: 'Sedan', passengers: 2, pickupTime: '10:00', notes: null }), '200000', randomUUID()]);
  await asUser(USERS.sales.id, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r', [added.itemId, cvAdd, await rvOf(cvAdd), [1, 2]]);
  await asUser(USERS.sales.id, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [cvAdd, await rvOf(cvAdd), JSON.stringify({
    hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null, inclusions: null,
    specialRequests: null, purchaseBudgetPaise: null }), '2300000']);
  await asUser(USERS.sales.id, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [cvAdd, await rvOf(cvAdd),
    JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: '2300000', dueDate: dayFromToday(10) }])]);
  await submit(add, cvAdd, [added.itemId]); // the set the screen shows: the added service counts as changed
  expect((await crRow(add)).status).toBe('requested');
  await approve(add);
  expect((await crRow(add)).status).toBe('applied');
  const tasksAfterAdd = await q<{ id: string; department: string; service_item_id: string }>(
    'select id, department, service_item_id from public.fulfilment_tasks where deal_id = $1', [dealId]);
  expect(tasksAfterAdd.length).toBe(tasksBefore.length + 1);
  expect(tasksAfterAdd.find((t) => t.service_item_id === added.itemId)!.department).toBe('purchase');

  // Remove the unbooked activity: route simple → task closed withdrawn.
  const removeActivity = await request(dealId, 'remove_service', [activityItem!], { changeSummary: 'Synthetic: drop the city walk' });
  expect((await crRow(removeActivity)).removal_route).toBe('simple');
  const cvA = await openVersion(removeActivity);
  await asUser(USERS.sales.id, 'select public.service_item_remove($1, $2, $3) as r', [activityItem, cvA, await rvOf(cvA)]);
  await asUser(USERS.sales.id, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [cvA, await rvOf(cvA), JSON.stringify({
    hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null, inclusions: null,
    specialRequests: null, purchaseBudgetPaise: null }), '2200000']);
  await asUser(USERS.sales.id, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [cvA, await rvOf(cvA),
    JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: '2200000', dueDate: dayFromToday(10) }])]);
  await submit(removeActivity, cvA, [activityItem!]);
  await approve(removeActivity);
  expect((await crRow(removeActivity)).status).toBe('applied');
  const activityTask = (await q<{ closed_state: string | null }>(`select t.closed_state from public.fulfilment_tasks t where t.service_item_id = $1`, [activityItem]))[0];
  expect(activityTask!.closed_state).toBe('withdrawn');

  // Remove the booked hotel: route cancellation; Purchase enters the supplier charges; the Manager approves (not before).
  const removeHotel = await request(dealId, 'remove_service', [hotelItem!], { changeSummary: 'Synthetic: drop the hotel', customerChargePaise: '50000' });
  expect((await crRow(removeHotel)).removal_route).toBe('cancellation');
  // O2: the Sales owner fills and sends the version first (the remaining services + the customer charge, LD32) …
  const cvH = await openVersion(removeHotel);
  await asUser(USERS.sales.id, 'select public.service_item_remove($1, $2, $3) as r', [hotelItem, cvH, await rvOf(cvH)]);
  await asUser(USERS.sales.id, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [cvH, await rvOf(cvH), JSON.stringify({
    hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null, inclusions: null,
    specialRequests: null, purchaseBudgetPaise: null }), '700000']);
  await asUser(USERS.sales.id, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [cvH, await rvOf(cvH),
    JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: '700000', dueDate: dayFromToday(10) }])]);
  await submit(removeHotel, cvH, [hotelItem!]);
  // … and the Manager cannot approve before the department entered the supplier charges (LD30).
  const early = await asUser(USERS.manager.id, 'select public.booking_change_request_decide($1, $2, $3, $4, $5) as r',
    [removeHotel, 'approve', null, (await crRow(removeHotel)).row_version, randomUUID()]).then(() => null, (e: { message: string }) => e.message);
  expect(early).toBe('charges_missing');
  // ASSUMPTION: purchase_cancellation_charge_set keeps its Phase 2 positional form (task, supplier keeps, refund expected, …) and finds the live
  // remove_service request of the task (11.3).
  await asUser(USERS.purchase.id, 'select public.purchase_cancellation_charge_set($1, $2::bigint, $3::bigint, $4, $5, $6, $7) as r',
    [hotel.taskId, '100000', '200000', null, null, 0, randomUUID()]);
  await approve(removeHotel);
  expect((await crRow(removeHotel)).status).toBe('applied');
  expect((await q<{ closed_state: string | null }>('select closed_state from public.fulfilment_tasks where id = $1', [hotel.taskId]))[0]!.closed_state).toBe('cancelled');
  // No whole-trip cancellation; supplier refund expected from the charge rows; the other services continue.
  expect((await q<{ n: number }>('select count(*)::int as n from public.deal_cancellations where deal_id = $1', [dealId]))[0]!.n).toBe(0);
  expect((await q<{ c: boolean }>('select authz.deal_trip_cancelled($1) as c', [dealId]))[0]!.c).toBe(false);
  expect((await q<{ closed_state: string | null }>(`select closed_state from public.fulfilment_tasks where service_item_id = $1`, [added.itemId]))[0]!.closed_state)
    .toBeNull();
  // The removed task appears in no Purchase work list.
  const list = await asUser(USERS.purchase.id, 'select public.purchase_task_list() as r');
  expect(list).not.toBeNull();
  expect(JSON.stringify(list)).not.toContain(hotel.taskId);

  // Overpayment (paid ₹20,000, new total ₹7,000) → the Phase 2 overpayment refund path works.
  const [receipt] = await q<{ id: string }>(`select id from public.customer_receipts where deal_id = $1 and status = 'verified' limit 1`, [dealId]);
  const refund = await asUser<{ refundRequestId: string }>(USERS.sales.id, 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r', [dealId,
    JSON.stringify({ kind: 'overpayment', outcome: 'payout', customerChargePaise: '0', amountPaise: '1300000', payeeKind: 'original_payer', payeeReceiptId: receipt!.id,
      payeeName: null, payeeReason: null, reason: 'Synthetic: the hotel was removed, return the extra money' }), randomUUID()]);
  expect(refund.refundRequestId).toBeTruthy();
  // No Credit Note is drafted for a service removal (LD13).
  expect((await documentsOf(dealId)).some((d) => d.kind === 'credit_note')).toBe(false);
  await so.ctx.close();
});

test('9. no outbound request except the app and the local Supabase', () => {
  expect(allowedOutbound()).toEqual([]);
});
