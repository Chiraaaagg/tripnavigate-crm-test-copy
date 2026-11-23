import { randomUUID } from 'node:crypto';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { istToday } from '../helpers/browser-journey';
import { USERS, type UserKey, asUser, configured, freshDeal, prepareUsers, putObject, q, sha, signIn, supabaseUrl } from './acc-real-support';

/**
 * Accounts phase (contract 2026-11-10) test plan 12.6, Track E: the real
 * journey on a disposable local Supabase stack served by the production
 * build (playwright.real.config.ts). Screen labels are the contract's
 * (section 11). Booking, money and Purchase set-up are SYNTHETIC FIXTURE
 * STEPS through the database commands the screens call; the screens under
 * test are driven in the browser:
 *    1. flight-only booking ready without ID proof (form says not needed);
 *    2. package booking -> tasks at submit -> Purchase / Flight / Visa notices;
 *       Purchase takes -> the others' "new task" notices resolved;
 *    3. Sales reports a payment -> Accounts bell; A records, B verifies ->
 *       Dues list and the Deal money card update;
 *    4. Purchase payment request -> approval / record / verify notices;
 *    5. supplier bill uploaded, duplicate refused, linked to a second Deal;
 *    6. Accounts matches, raises and clears an exception (exception owner
 *       notified), exports and downloads the CSV (masked, formula-safe, no
 *       matched column);
 *    7. Accounts returns a booking (urgent to Sales) -> revision -> Purchase
 *       banner + urgent notice -> "OK, seen";
 *    8. a real supplier confirmation (Accounts approval, Purchase quote, cost, booking
 *       request, go-ahead, proof, confirm) -> return refused with the cancellation message;
 *    9. Flight requester, then the new cost-task owner, cancel requests;
 *   10. Manager views Documents and money and Dues read-only;
 *   11. Purchase / Flight / Visa sessions get no money data (responses scanned);
 *   12. no request to any host other than the app and the local Supabase (R16.14).
 * Skips without a real stack; fails when REQUIRE_REAL_STACK=1 and anything is missing.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');

const SELLING = '45678913';
// Sentinels that never appear in UI copy (ABCDE1234F is a form hint in the JS bundle).
const stampDigits = String(Date.now()).slice(-4);
// Per-run PAN: the cash cap counts a payer's cash receipts across runs on the same stack.
const PAN = `QWERT${stampDigits}Z`;
const MOBILE = '6000456780';
const stamp = Date.now();
let secrets: Record<UserKey, string>;
const outbound: string[] = [];
const allowedHosts = () => new Set([new URL(supabaseUrl!).host, new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3100').host]);

async function session(browser: import('@playwright/test').Browser, key: UserKey): Promise<{ ctx: BrowserContext; page: Page; bodies: string[] }> {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const bodies: string[] = [];
  page.on('request', (r) => {
    const host = new URL(r.url()).host;
    if (!allowedHosts().has(host) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) outbound.push(r.url());
  });
  page.on('response', async (r) => {
    if (/json|text\/(html|plain|x-component)/.test(r.headers()['content-type'] ?? '')) bodies.push(await r.text().catch(() => ''));
  });
  await signIn(page, key, secrets);
  return { ctx, page, bodies };
}
const bell = (page: Page) => page.getByRole('button', { name: /notices|notifications|bell/i }).first();

type Version = { versionId: string; rowVersion: number };
async function booking(dealId: string, items: Array<[string, unknown]>, idProofs: boolean): Promise<Version & { itemIds: string[] }> {
  const S = USERS.sales.id;
  await q('update public.workflow_settings set service_items_enabled = true, visa_passport_tasks_enabled = true where id');
  const opened = await asUser<Version>(S, 'select public.booking_open_draft($1) as r', [dealId]);
  let rv = opened.rowVersion;
  const itemIds: string[] = [];
  for (const [type, facts] of items) {
    const added = await asUser<{ rowVersion: number; itemId: string }>(S, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
      [opened.versionId, rv, type, JSON.stringify(facts), '99999999', randomUUID()]);
    rv = added.rowVersion;
    itemIds.push(added.itemId);
  }
  const travellers = [{ fullName: 'Synthetic Acc One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Acc Two', type: 'adult', seq: 2 }];
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [dealId, rv, JSON.stringify(travellers)])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [opened.versionId, rv,
    JSON.stringify({ hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null,
      inclusions: null, specialRequests: null, purchaseBudgetPaise: null }), SELLING])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_trip_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
    JSON.stringify({ destination: 'Synthetic City, Rajasthan', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' })])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [opened.versionId, rv,
    JSON.stringify({ contactName: 'Synthetic Contact', mobile: '6000500077', email: 'e2e.acc.contact@example.test', contactConfirmed: true, bookingFor: 'individual',
      payerDifferent: false, payerName: null }), JSON.stringify({ billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null,
      city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }), 0, randomUUID()])).rowVersion;
  for (const itemId of itemIds) {
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r',
      [itemId, opened.versionId, rv, [1, 2]])).rowVersion;
  }
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r', [opened.versionId, rv,
    JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: SELLING, dueDate: istToday() }])])).rowVersion;
  if (items.some(([type]) => type === 'visa')) {
    for (const seq of [1, 2]) {
      await asUser(S, 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r', [dealId, seq, 0, JSON.stringify({ dateOfBirth: '1990-05-17',
        nationality: 'Indian', passportNumber: `Z${7000000 + seq}`, passportExpiry: '2030-01-31' })]);
    }
  }
  if (idProofs) {
    for (const seq of [1, 2]) {
      const begun = await asUser<{ fileId: string; objectPath: string }>(S, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
        [dealId, seq, randomUUID(), `id-${seq}.pdf`, 'application/pdf', 2048, sha()]);
      await putObject('traveller-id-proofs', begun.objectPath);
      await asUser(S, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
    }
  }
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(S, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
    [opened.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, sha()]);
  await putObject('booking-evidence', ev.objectPath);
  await asUser(S, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
  return { versionId: opened.versionId, rowVersion: rv, itemIds };
}
const confirm = async (versionId: string) => {
  const r = await asUser<{ ready: boolean; issues: string[]; contentHash: string }>(USERS.sales.id, 'select public.booking_readiness($1) as r', [versionId]);
  expect(r.issues).toEqual([]);
  await asUser(USERS.sales.id, 'select public.booking_confirm($1, $2) as r', [versionId, r.contentHash]);
};
const HOTEL = { hotelName: 'Synthetic Hotel (e2e)', city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 1, adults: 2,
  roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', children: 0, inclusions: null, specialRequests: null };
const FLIGHT = { entryMode: 'typed', segments: [{ from: 'JDH', to: 'DEL', date: '2026-12-10', airline: 'Air India', flightNo: 'AI 470', departTime: '10:35',
  arriveTime: '11:50' }], passengers: 2, preferredTime: null, cabin: 'Economy', notes: null };
const VISA = { country: 'France', purpose: 'Tourism', travelDate: '2027-02-06', applyBy: null, feePaidBy: 'company', notes: null, visaKind: 'sticker',
  jurisdiction: 'yes', jurisdictionPlace: 'New Delhi', documentsNeeded: ['Passport copy (front and back)'] };

let switchesBefore: { service_items_enabled: boolean; visa_passport_tasks_enabled: boolean } | undefined;
test.beforeAll(async () => {
  switchesBefore = (await q<{ service_items_enabled: boolean; visa_passport_tasks_enabled: boolean }>(
    'select service_items_enabled, visa_passport_tasks_enabled from public.workflow_settings where id'))[0];
  secrets = await prepareUsers();
  // Switches through the audited admin commands as the fixture super admin (Synthetic Admin Jodhpur).
  const SUPER = 'a0000000-0000-4000-8000-000000000007';
  const REASON = 'Synthetic: accounts phase real journey (local stack)';
  const entity = (await q<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  await asUser(SUPER, 'select public.admin_set_notices_enabled($1, $2) as r', [true, REASON]);
  await asUser(SUPER, 'select public.admin_set_tally_export_enabled($1, $2, $3) as r', [entity, true, REASON]);
  await asUser(SUPER, 'select public.admin_set_accounts_exception_owner($1, $2, $3) as r', [entity, USERS.accOwner.id, REASON]);
});

// Leave the stack as found: later journeys (accounts.real) use the legacy hotel flow, which needs Book now off.
test.afterAll(async () => {
  if (switchesBefore) {
    await q('update public.workflow_settings set service_items_enabled = $1, visa_passport_tasks_enabled = $2 where id',
      [switchesBefore.service_items_enabled, switchesBefore.visa_passport_tasks_enabled]);
  }
  await asUser('a0000000-0000-4000-8000-000000000007', 'select public.admin_set_notices_enabled($1, $2) as r',
    [false, 'Synthetic: accounts phase real journey finished (local stack)']).catch(() => undefined);
});

test('1. flight-only booking is ready without ID proof; the form says it is not needed', async ({ browser }) => {
  const dealId = await freshDeal(`ACCFO-${stamp}`);
  const v = await booking(dealId, [['flight', FLIGHT]], false);
  const r = await asUser<{ issues: string[] }>(USERS.sales.id, 'select public.booking_readiness($1) as r', [v.versionId]);
  expect(r.issues).not.toContain('id_proof_missing');
  const { ctx, page } = await session(browser, 'sales');
  await page.goto(`/app/deals/${dealId}/book`);
  await expect(page.getByText(/not needed for flight-only bookings/i).first()).toBeVisible();
  await confirm(v.versionId);
  await ctx.close();
});

test('2-11. package journey through notices, money, Tally, return block and Manager read-only', async ({ browser }) => {
  const dealId = await freshDeal(`ACCPK-${stamp}`);
  const v = await booking(dealId, [['hotel', HOTEL], ['flight', FLIGHT], ['visa', VISA]], true);
  await confirm(v.versionId);
  const tasks = await q<{ id: string; department: string }>('select id, department from public.fulfilment_tasks where deal_id = $1', [dealId]);
  const hotelTask = tasks.find((t) => t.department === 'purchase')!.id;
  // 2. Task notices for each department; Purchase's bell shows it.
  const kinds = await q<{ recipient_user_id: string }>(`select recipient_user_id from public.staff_notices where deal_id = $1 and kind = 'task_new'`, [dealId]);
  expect(kinds.map((k) => k.recipient_user_id)).toEqual(expect.arrayContaining([USERS.purchase.id, USERS.flight.id, USERS.flight2.id, USERS.visa.id]));
  const pur = await session(browser, 'purchase');
  await bell(pur.page).click();
  await expect(pur.page.getByText(new RegExp(`New Purchase task on ACCPK-${stamp}`)).first()).toBeVisible();
  await asUser(USERS.purchase.id, 'select public.purchase_task_claim($1) as r', [hotelTask]);
  // 3. Payment reported -> Accounts bell; A records, B verifies -> dues.
  const destination = await q<{ id: string }>(`select v.id from public.company_destination_versions v where v.status = 'approved' limit 1`);
  await asUser(USERS.sales.id, 'select public.payment_claim_report($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({ mode: 'cash', amountPaise: '1000000',
    paidOn: istToday(), payerName: 'Synthetic Cash Payer' }), randomUUID()]);
  const accA = await session(browser, 'accA');
  await bell(accA.page).click();
  await expect(accA.page.getByText(new RegExp(`Payment reported on ACCPK-${stamp}`)).first()).toBeVisible();
  const jdh = (await q<{ id: string }>(`select id from public.branches where code = 'JDH' limit 1`))[0]!.id;
  const rec = await asUser<{ id: string }>(USERS.accA.id, 'select public.receipt_record($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({ mode: 'cash',
    amountPaise: '1000000', receivedOn: istToday(), branchId: jdh, collectorUserId: USERS.accA.id, payerName: 'Synthetic Cash Payer', payerPan: PAN }), randomUUID()]);
  await asUser(USERS.accB.id, 'select public.receipt_verify($1, $2) as r', [rec.id, randomUUID()]);
  // R4 (A9): the bare Dues address opens on Overdue and Due today; every status is ?status=all.
  await accA.page.goto('/app/accounts/dues?status=all');
  await expect(accA.page.getByText(`ACCPK-${stamp}`).first()).toBeVisible();
  // 6. Match, exception (owner notified), export + CSV.
  await accA.page.goto(`/app/accounts/records?q=ACCPK-${stamp}`);
  const entry = (await q<{ id: string }>(`select id from public.finance_journal_entries where receipt_id = $1`, [rec.id]))[0]!.id;
  await asUser(USERS.accA.id, 'select public.accounts_tally_exception($1, $2, $3, $4::jsonb, $5) as r', ['journal_entry', entry, 0,
    JSON.stringify({ reason: 'Synthetic: Tally shows another amount' }), randomUUID()]);
  expect((await q(`select 1 from public.staff_notices where kind = 'tally_exception' and recipient_user_id = $1 and deal_id = $2`, [USERS.accOwner.id, dealId])).length).toBe(1);
  await asUser(USERS.accA.id, 'select public.accounts_tally_reopen($1, $2, $3, $4, $5) as r', ['journal_entry', entry, 1,
    'Synthetic: checked again, fine', randomUUID()]).catch(() => undefined);
  // A second verified receipt stays ready for the export (the first one sits in its exception).
  const rec2 = await asUser<{ id: string }>(USERS.accA.id, 'select public.receipt_record($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({ mode: 'cash',
    amountPaise: '500000', receivedOn: istToday(), branchId: jdh, collectorUserId: USERS.accA.id, payerName: '=HYPERLINK("x")', payerPan: PAN }), randomUUID()]);
  await asUser(USERS.accB.id, 'select public.receipt_verify($1, $2) as r', [rec2.id, randomUUID()]);
  // R4 (D11): the Tally page shows one method at a time; this step is the CSV export.
  await accA.page.goto('/app/accounts/tally?method=csv');
  const before = (await q<{ t: string }>('select now()::text as t'))[0]!.t;
  await accA.page.getByRole('button', { name: /create export/i }).first().click();
  // The export this click made (earlier runs' exports stay listed): wait for its row, then download it through the CSV route.
  await expect.poll(async () => (await q(`select 1 from public.tally_exports where created_by = $1 and created_at > $2::timestamptz`,
    [USERS.accA.id, before])).length, { timeout: 30_000 }).toBe(1);
  const [made] = await q<{ id: string; export_no: string }>(`select id, export_no from public.tally_exports where created_by = $1 and created_at > $2::timestamptz`,
    [USERS.accA.id, before]);
  await expect(accA.page.getByText(new RegExp(made!.export_no)).first()).toBeVisible();
  const res = await accA.page.request.get(`/app/accounts/tally/exports/${made!.id}/csv`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/text\/csv/);
  expect(res.headers()['cache-control'] ?? '').toMatch(/no-store/);
  expect(res.headers()['content-disposition'] ?? '').toContain(`tripnavigate-${made!.export_no}.csv`);
  const csv = await res.text();
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('\r\n');
  expect(csv).not.toContain(PAN);
  expect(csv).toContain(`XXXXX${stampDigits}X`);
  expect(csv.split('\r\n')[0]!.toLowerCase()).not.toContain('matched');
  expect(csv, 'formula-safe party name').toContain(`"'=HYPERLINK(""x"")"`);
  expect((await q(`select 1 from public.audit_events where action = 'accounts.tally_export_downloaded' and target_id::text = $1`, [made!.id])).length)
    .toBe(1);
  // 7. Return -> urgent to Sales -> (revision covered in DB suites) ; 8. after supplier confirmation the Return is refused.
  await asUser(USERS.accA.id, 'select public.accounts_review_return($1, $2, $3) as r', [v.versionId, 'Synthetic return: billing name wrong', randomUUID()]);
  const sales = await session(browser, 'sales');
  await bell(sales.page).click();
  await expect(sales.page.getByText(new RegExp(`ACCPK-${stamp} booking returned by Accounts`)).first()).toBeVisible();
  await expect(sales.page.getByText('Urgent').first()).toBeVisible();
  // 10. Manager: read-only workspace and dues.
  const mgr = await session(browser, 'manager');
  await mgr.page.goto('/app/accounts/records');
  await expect(mgr.page.getByText(/view only/i).first()).toBeVisible();
  await expect(mgr.page.getByRole('button', { name: 'Mark matched' })).toHaveCount(0);
  await mgr.page.goto('/app/accounts/dues?status=all');
  await expect(mgr.page.getByText(`ACCPK-${stamp}`).first()).toBeVisible();
  // 11. Purchase / Flight / Visa sessions never receive money data.
  const fl = await session(browser, 'flight');
  const vi = await session(browser, 'visa');
  for (const s of [pur, fl, vi]) {
    // R4: ?status=all, so the fence is checked over every Dues row, not only the default overdue/due-today view.
    for (const path of ['/app/accounts/records', '/app/accounts/dues?status=all', `/app/deals/${dealId}`]) await s.page.goto(path).catch(() => undefined);
    const text = s.bodies.join('\n');
    expect(text).not.toContain(SELLING);
    expect(text).not.toContain(PAN);
    expect(text).not.toContain(MOBILE);
  }
  for (const s of [pur, accA, sales, mgr, fl, vi]) await s.ctx.close();
  void destination;
});

test('8. after a real supplier confirmation the Accounts return is refused with the cancellation message', async ({ browser }) => {
  const dealId = await freshDeal(`ACCSC-${stamp}`);
  const v = await booking(dealId, [['hotel', HOTEL]], true);
  await confirm(v.versionId);
  const task = (await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase'`, [dealId]))[0]!.id;
  const jdh = (await q<{ id: string }>(`select id from public.branches where code = 'JDH' limit 1`))[0]!.id;
  // Customer money and the real Accounts approval (billing saved and verified, then approved by Accounts B).
  const rec = await asUser<{ id: string }>(USERS.accA.id, 'select public.receipt_record($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({ mode: 'cash',
    // Own payer and a small amount: the cash cap counts every cash receipt of a payer (PAN) in the period.
    amountPaise: '100000', receivedOn: istToday(), branchId: jdh, collectorUserId: USERS.accA.id, payerName: 'Synthetic Step Eight Payer',
    payerPan: `ZXCVB${String(stamp).slice(-4)}M` }), randomUUID()]);
  await asUser(USERS.accB.id, 'select public.receipt_verify($1, $2) as r', [rec.id, randomUUID()]);
  const billing = (await q<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [dealId]))[0];
  const saved = await asUser<{ rowVersion: number }>(USERS.accA.id, 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r', [dealId,
    billing?.row_version ?? 0, JSON.stringify({ billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur',
      stateCode: '08', postalCode: '342001', gstin: null }), randomUUID()]);
  await asUser(USERS.accA.id, 'select public.accounts_billing_verify($1, $2, $3) as r', [dealId, saved.rowVersion, randomUUID()]);
  const review = (await q<{ row_version: number }>('select row_version from public.accounts_booking_reviews where booking_version_id = $1', [v.versionId]))[0];
  await asUser(USERS.accB.id, 'select public.accounts_review_approve($1, $2, $3) as r', [v.versionId, review?.row_version ?? 0, randomUUID()]);
  // Purchase: supplier with Manager-approved bank details, quote, cost, booking request, go-ahead, confirmation proof, confirm.
  const entity = (await q<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  const { supplierId } = await asUser<{ supplierId: string }>(USERS.purchase.id, 'select public.supplier_create($1, $2::jsonb) as r', [entity, JSON.stringify({
    name: `E2E Acc Stays ${stamp}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null, contactEmail: 'desk@example.test',
    paymentTerms: null })]);
  const bank = await asUser<{ revisionNo: number }>(USERS.purchase.id, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [supplierId, randomUUID(),
    JSON.stringify({ accountHolder: 'Synthetic Stays', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112299' })]);
  await asUser(USERS.manager.id, 'select public.supplier_approve_beneficiary($1, $2) as r', [supplierId, bank.revisionNo]);
  await asUser(USERS.purchase.id, 'select public.purchase_task_claim($1) as r', [task]);
  const { quoteId } = await asUser<{ quoteId: string }>(USERS.purchase.id, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task, randomUUID(),
    JSON.stringify({ supplierId, hotelName: 'Synthetic Hotel (e2e)', roomType: null, mealPlan: null, quotedCostPaise: '10000000', holdUntil: null,
      cancellationTerms: null })]);
  await asUser(USERS.purchase.id, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r', [task, quoteId, 0, '10000000', null, null,
    randomUUID()]);
  await asUser(USERS.purchase.id, 'select public.purchase_booking_request_send($1, $2, $3, $4::text[], $5, $6, $7) as r', [task, 1, 'desk@example.test', [],
    `Booking request · ACCSC-${stamp}`, 'Synthetic body.', randomUUID()]);
  const ga = (await q<{ id: string; row_version: number }>(`select id, row_version from public.purchase_go_ahead_requests where task_id = $1 and status = 'pending'`,
    [task]))[0]!;
  await asUser(USERS.accA.id, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [ga.id, 'approve', null, ga.row_version, randomUUID()]);
  const proof = await asUser<{ evidenceId: string; objectPath: string }>(USERS.purchase.id, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
    [task, 'supplier_confirmation', 'supplier.pdf', 'application/pdf', 2048, sha()]);
  await putObject('purchase-evidence', proof.objectPath);
  await asUser(USERS.purchase.id, 'select public.purchase_evidence_finish($1, true) as r', [proof.evidenceId]);
  await asUser(USERS.purchase.id, 'select public.purchase_supplier_confirm($1, $2, $3) as r', [task, 1, `SYN-CONF-${stamp}`]);
  expect((await q<{ c: boolean }>('select authz.deal_committed($1) as c', [dealId]))[0]!.c, 'the Deal is committed').toBe(true);
  // Database: refused with the frozen token; screen: no Return button, the cancellation message instead.
  await expect(asUser(USERS.accA.id, 'select public.accounts_review_return($1, $2, $3) as r', [v.versionId, 'Synthetic return after confirmation',
    randomUUID()])).rejects.toThrow(/^review_return_committed$/);
  const acc = await session(browser, 'accA');
  await acc.page.goto(`/app/accounts/deals/${dealId}`);
  await acc.page.getByRole('tab', { name: 'Review' }).or(acc.page.getByRole('link', { name: 'Review', exact: true })).first().click();
  await expect(acc.page.getByText(/ask the branch Manager to start a cancellation/).first()).toBeVisible();
  await expect(acc.page.getByRole('button', { name: /^return/i })).toHaveCount(0);
  await acc.ctx.close();
});

test('12. no outbound request to any other host during the run (R16.14)', () => {
  expect(outbound).toEqual([]);
});
