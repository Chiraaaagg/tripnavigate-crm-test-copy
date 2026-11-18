import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { challengeViaUi, signInViaUi, totpCode } from '../helpers/browser-journey';
import { Counter, record } from './click-count-harness';
import {
  FLIGHT, HOTEL, USERS, VISA, type UserKey, approveBooking, approvedDeal, asUser, configured, confirmedBooking, entityId, freshDeal,
  istToday, prepareUsers, q, restoreSwitches3, saveSwitches3, session, stamp, supplierConfirmedHotel, switchesOn3, ticketBatch, verifiedCash,
} from './acc3-real-support';

/**
 * UX redesign R0, build plan 4.9: the "before" click counts, measured on the
 * untouched branch (production build, disposable local Supabase stack,
 * synthetic data). Every journey starts on Home right after sign-in and
 * reaches its goal only by clicking and typing as a person would; the set-up
 * before it (Deals, bookings, tasks, receipts) is SYNTHETIC FIXTURE STEPS
 * through the database commands the screens call, as the other real journeys
 * do, and is not counted.
 *
 * Results: one line per journey in test-results/click-counts.jsonl and in the
 * test output as a table row (journey | slice | clicks | typed fields | page
 * loads | screens | scrolls | source). The same file is run again when each
 * slice is frozen, for the "after" numbers.
 */

test.skip(!configured, 'needs the real local stack (TEST_DATABASE_URL, Supabase URL and keys)');
test.setTimeout(10 * 60_000);
test.use({ actionTimeout: 30_000, viewport: { width: 1280, height: 860 } });

const RESULTS = join(import.meta.dirname, '..', '..', 'test-results', 'click-counts.jsonl');
const SUPER_ID = 'a0000000-0000-4000-8000-000000000007';
const SUPER_EMAIL = 'admin.jodhpur@example.test';
const REASON = 'Synthetic: R0 click-count journey on the local stack';
const PDF = { name: 'synthetic-file.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic click-count file\n') };

let secrets: Record<UserKey, string>;
let superSecret: string;

test.beforeAll(async () => {
  await saveSwitches3();
  secrets = await prepareUsers();
  await switchesOn3({ changes: true, serviceChanges: true });
  superSecret = await enrolSuperAdmin();
});
test.afterAll(async () => {
  await restoreSwitches3();
});

/** The fixture Super Admin (seed-local) gets a fresh TOTP factor; returns its secret. */
async function enrolSuperAdmin(): Promise<string> {
  const password = process.env.LOCAL_FIXTURE_PASSWORD;
  expect(password, 'LOCAL_FIXTURE_PASSWORD (seed-local) is needed for the Super Admin').toBeTruthy();
  await q('delete from auth.mfa_factors where user_id = $1', [SUPER_ID]);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  const c = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const signed = await c.auth.signInWithPassword({ email: SUPER_EMAIL, password: password! });
  if (signed.error) throw new Error('Super Admin sign-in failed');
  const enrolled = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: `r0-clicks-${Date.now()}` });
  if (enrolled.error) throw new Error('Super Admin TOTP enrolment failed');
  const verified = await c.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: await totpCode(enrolled.data.totp.secret) });
  if (verified.error) throw new Error('Super Admin TOTP verification failed');
  await c.auth.signOut({ scope: 'local' });
  return enrolled.data.totp.secret;
}

async function signedIn(browser: Browser, who: UserKey | 'super'): Promise<Page> {
  if (who !== 'super') return (await session(browser, who, secrets)).page;
  const page = await (await browser.newContext()).newPage();
  await signInViaUi(page, SUPER_EMAIL, process.env.LOCAL_FIXTURE_PASSWORD!);
  await challengeViaUi(page, superSecret);
  await expect(page).toHaveURL(/\/app/);
  return page;
}

let current: Page | undefined;
test.afterEach(async ({}, info) => {
  // On a failure, print what the person's page showed (the default page fixture is not the journey's page).
  if (info.status !== info.expectedStatus && current) {
    console.log(`--- ${info.title}: ${current.url()}\n${await current.locator('main').ariaSnapshot().catch(() => '(no main)')}`);
  }
  current = undefined;
});

/** Opens Home and starts counting there. */
async function fromHome(page: Page, journey: string, slice: string): Promise<Counter> {
  current = page;
  await page.goto('/app');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const c = new Counter(page, journey, slice);
  c.start();
  return c;
}

const menu = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
const finish = (c: Counter) => console.log(record(RESULTS, c.counts));

/** Home → Deals → search the reference → open the Deal (the "today" way to reach a known Deal). */
async function openDealBySearch(c: Counter, page: Page, reference: string) {
  await c.click(menu(page, 'Deals'), 'menu Deals');
  await c.fill(page.getByRole('searchbox', { name: 'Search deals' }), reference, 'Deal reference');
  await c.click(page.getByRole('button', { name: 'Search', exact: true }), 'Search');
  await c.click(page.getByRole('link', { name: new RegExp(reference) }).first(), `open Deal ${reference}`);
  await expect(page).toHaveURL(/\/app\/deals\/[0-9a-f-]{36}/);
}

// ---------------------------------------------------------------- R1 Menu and Settings

test('R1 Super Admin switches one Accounts setting', async ({ browser }) => {
  const page = await signedIn(browser, 'super');
  const c = await fromHome(page, 'Super Admin switches one Accounts setting', 'R1');
  await c.click(menu(page, 'Settings'), 'menu Settings');
  await c.click(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Accounts', exact: true }), 'Settings tab Accounts');
  const form = page.getByRole('form', { name: /^Tally export for / }).first();
  await c.fill(form.getByLabel('Reason'), REASON, 'Reason');
  await c.click(form.getByRole('button', { name: /^Switch (on|off)$/ }), 'Switch on/off');
  await expect(form.getByRole('status').filter({ hasText: /Saved/ })).toBeVisible();
  finish(c);
});

test('R1 Super Admin switches a customer message on', async ({ browser }) => {
  const page = await signedIn(browser, 'super');
  const c = await fromHome(page, 'Super Admin switches a customer message on', 'R1');
  await c.click(menu(page, 'Settings'), 'menu Settings');
  await c.click(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Features', exact: true }), 'Settings tab Features');
  await c.click(page.getByRole('link', { name: 'Open Customer messages' }), 'Open Customer messages');
  await c.click(page.getByRole('button', { name: 'Turn on: Booking confirmed by E-mail' }), 'Turn on (Booking confirmed, E-mail)');
  const dialog = page.getByRole('dialog', { name: 'Turn on: Booking confirmed by E-mail' });
  await c.fill(dialog.getByLabel('Reason'), REASON, 'Reason');
  await c.click(dialog.getByRole('button', { name: 'Turn on', exact: true }), 'Turn on (confirm)');
  await expect(page.getByRole('status').filter({ hasText: /Saved/ }).first()).toBeVisible();
  finish(c);
});

test('R1 Super Admin changes a Features switch', async ({ browser }) => {
  const before = (await q<{ on: boolean }>('select intake_prompt_enabled as on from public.workflow_settings where id'))[0]!.on;
  const page = await signedIn(browser, 'super');
  const c = await fromHome(page, 'Super Admin changes a Features switch', 'R1');
  await c.click(menu(page, 'Settings'), 'menu Settings');
  await c.click(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Features', exact: true }), 'Settings tab Features');
  const title = 'Count of won deals with no booking (on Home)';
  await c.click(page.getByRole('button', { name: `Change ${title}` }), 'Change');
  const form = page.getByRole('form', { name: `Change ${title}` });
  await c.click(form.getByRole('radio', { name: before ? 'Off' : 'On' }), before ? 'Off' : 'On');
  await c.fill(form.getByLabel('Why are you changing it?'), REASON, 'Why are you changing it?');
  await c.click(form.getByRole('button', { name: 'Review change' }), 'Review change');
  await c.click(form.getByRole('button', { name: `Turn ${title} ${before ? 'off' : 'on'}` }), 'Turn on/off');
  await expect(page.getByRole('status').filter({ hasText: 'Recorded with your name and reason.' })).toBeVisible();
  finish(c);
  await asUser(SUPER_ID, 'select public.admin_set_workflow_setting($1, $2, $3) as r', ['intake_prompt_enabled', before, REASON]).catch(() => undefined);
});

test('R1 Accounts checks whether supplier lists hold work', async ({ browser }) => {
  const page = await signedIn(browser, 'accA');
  const c = await fromHome(page, 'Accounts checks whether supplier lists hold work', 'R1');
  for (const [item, h1] of [['Hotel go-ahead', 'Hotel go-ahead requests'], ['Supplier payments', 'Supplier payments'], ['Supplier invoices', 'Supplier invoices'],
    ['Company funding', 'Company funding']] as const) {
    await c.click(menu(page, item), `menu ${item}`);
    await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
  }
  finish(c);
});

// ---------------------------------------------------------------- R2 Sales

test('R2 Sales finds today\'s Deal and reaches the work', async ({ browser }) => {
  const { reference } = await approvedDeal('R0CCFIND', 1);
  const page = await signedIn(browser, 'sales');
  const c = await fromHome(page, 'Sales finds today\'s Deal and reaches the work', 'R2');
  await openDealBySearch(c, page, reference);
  await c.click(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Services and tasks' }), 'Deal tab Services and tasks');
  await expect(page).toHaveURL(/tab=services/);
  finish(c);
});

test('R2 Sales starts Book now', async ({ browser }) => {
  const reference = `R0CCBOOK-${stamp}`;
  await freshDeal(reference);
  const page = await signedIn(browser, 'sales');
  const c = await fromHome(page, 'Sales starts Book now', 'R2');
  await openDealBySearch(c, page, reference);
  await c.click(page.getByRole('button', { name: 'Start booking', exact: true }), 'Start booking');
  await expect(page).toHaveURL(/\/book\/travellers/);
  finish(c);
});

test('R2 Sales records a customer payment claim', async ({ browser }) => {
  const reference = `R0CCCLAIM-${stamp}`;
  const dealId = await freshDeal(reference);
  await asUser(USERS.sales.id, 'select public.booking_open_draft($1) as r', [dealId]);
  const page = await signedIn(browser, 'sales');
  const c = await fromHome(page, 'Sales records a customer payment claim', 'R2');
  await openDealBySearch(c, page, reference);
  await c.click(page.getByRole('link', { name: 'Continue booking' }).first(), 'Continue booking');
  await c.click(page.getByRole('navigation', { name: 'Booking steps' }).getByRole('button', { name: /Price|Finish|step 3/i }).last()
    .or(page.getByRole('link', { name: /step 3/i })).first(), 'Booking step 3');
  await c.click(page.getByText('Payment already received? (optional)'), 'Payment already received?');
  const form = page.getByRole('form', { name: 'Tell Accounts about a payment' });
  await c.select(form.getByLabel('How they paid'), { label: 'Cash' }, 'How they paid');
  await c.fill(form.getByLabel(/^Amount/), '25000', 'Amount');
  await c.fill(form.getByLabel('Paid on'), istToday(), 'Paid on');
  await c.fill(form.getByLabel('Paid by'), 'Synthetic Payer', 'Paid by');
  await c.click(form.getByRole('button', { name: 'Send to Accounts' }), 'Send to Accounts');
  await expect(page.getByRole('status').filter({ hasText: /Accounts/ }).first()).toBeVisible();
  finish(c);
});

test('R2 Sales requests a change after confirmation', async ({ browser }) => {
  const { dealId, reference } = await approvedDeal('R0CCCHG', 2);
  await supplierConfirmedHotel(dealId);
  const page = await signedIn(browser, 'sales');
  const c = await fromHome(page, 'Sales requests a change after confirmation (to the change form)', 'R2');
  await openDealBySearch(c, page, reference);
  await c.click(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Services and tasks' }), 'Deal tab Services and tasks');
  await c.click(page.getByRole('button', { name: 'Request a change' }).first(), 'Request a change');
  const dialog = page.getByRole('dialog', { name: 'Request a change' });
  await c.click(dialog.getByRole('group', { name: 'Which confirmed services change?' }).getByRole('checkbox').first(), 'tick the service');
  await c.fill(dialog.getByLabel('What changes'), 'Synthetic: one more night.', 'What changes');
  await c.fill(dialog.getByLabel('Why'), 'Synthetic: the customer asked.', 'Why');
  await c.click(dialog.getByRole('button', { name: 'Start the change' }), 'Start the change');
  await c.click(page.getByRole('button', { name: /^Start the change in the booking for / }).first(), 'Start the change in the booking');
  await c.click(page.getByRole('link', { name: 'Fill in and send the change' }).first(), 'Fill in and send the change');
  await expect(page).toHaveURL(/\/book\//);
  await expect(page.getByRole('button', { name: 'Send change' })).toBeVisible();
  // Not counted further: editing the frozen Book now form and sending needs a new customer acceptance file, and the
  // fixture booking (acc2 helper) leaves step 1 incomplete, so "Send change" stays disabled on this stack. The count
  // stops where the redesign changes the path (Deal page → Book now in change mode).
  finish(c);
});

// ---------------------------------------------------------------- R3 Desks and Manager

async function hotelTaskReady(slot: number) {
  const deal = await approvedDeal('R0CCPUR', slot);
  const supplier = `R0 Synthetic Stays ${stamp}-${slot}`;
  await asUser(USERS.purchase.id, 'select public.supplier_create($1, $2::jsonb) as r', [await entityId(), JSON.stringify({
    name: supplier, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null, contactEmail: 'desk@example.test',
    paymentTerms: null, supplierKind: 'direct' })]);
  return { ...deal, supplier };
}

/** Menu → (a list filter when the task is not on the first one) → the task's row, found by its Deal reference. */
const openTask = async (c: Counter, page: Page, menuName: string, reference: string, filter?: RegExp) => {
  await c.click(menu(page, menuName), `menu ${menuName}`);
  if (filter) await c.click(page.getByRole('main').getByRole('link', { name: filter }).first(), 'list filter');
  // Purchase and Flight lists are tables; the Visa list is a list of cards.
  const rows = page.getByRole('main').getByRole('row').or(page.getByRole('main').getByRole('listitem'));
  await c.click(rows.filter({ hasText: reference }).getByRole('link').first(), `open the task of ${reference}`);
};
const workTab = (page: Page) => page.getByRole('navigation', { name: 'Task sections' }).getByRole('link', { name: 'Work', exact: true });

test('R3 Purchase takes a hotel task and records the confirmation', async ({ browser }) => {
  const { dealId, supplier, reference } = await hotelTaskReady(3);
  const page = await signedIn(browser, 'purchase');
  const c = await fromHome(page, 'Purchase takes a hotel task and records the confirmation', 'R3');
  await openTask(c, page, 'Purchase tasks', reference);
  await c.click(page.getByRole('button', { name: 'Take this task' }), 'Take this task');
  await c.click(workTab(page), 'Task tab Work');
  const add = page.getByRole('form', { name: 'Add a rate' });
  await c.select(add.getByLabel('Supplier'), { label: supplier }, 'Supplier');
  await c.fill(add.getByLabel('Amount for the whole stay (₹)'), '30000', 'Amount for the whole stay');
  await c.click(add.getByRole('button', { name: 'Add rate' }), 'Add rate');
  await c.click(page.getByRole('button', { name: 'Use as final rate' }).first(), 'Use as final rate');
  await c.click(page.getByRole('button', { name: 'Send booking request' }).first(), 'Send booking request');
  const mail = page.getByRole('dialog', { name: 'Send the booking request' });
  await c.click(mail.getByRole('button', { name: 'Mark as sent' }), 'Mark as sent');
  await c.click(mail.getByRole('button', { name: 'Close' }).first(), 'Close');
  // Accounts gives the go-ahead (another person; not counted).
  const [g] = await q<{ id: string; row_version: number }>(`select g.id, g.row_version from public.purchase_go_ahead_requests g
    join public.fulfilment_tasks t on t.id = g.task_id where t.deal_id = $1 and g.status = 'pending'`, [dealId]);
  await asUser(USERS.accA.id, 'select public.purchase_go_ahead_decide($1, $2, $3, $4, $5) as r', [g!.id, 'approve', null, g!.row_version, randomUUID()]);
  await page.reload(); // the person sees the go-ahead when the page next loads; not counted as their action
  c.counts.pageLoads--;
  c.counts.screens--;
  const upload = page.getByRole('form', { name: 'Upload a Purchase file' });
  await c.select(upload.getByLabel('What is this file?'), 'supplier_confirmation', 'What is this file?');
  await c.upload(upload.getByLabel('File', { exact: true }), PDF, 'File');
  await c.click(upload.getByRole('button', { name: 'Upload file' }), 'Upload file');
  await c.click(page.getByRole('button', { name: 'Record supplier confirmation' }).first(), 'Record supplier confirmation');
  const confirm = page.getByRole('dialog');
  await c.fill(confirm.getByLabel('Supplier confirmation reference'), `SYN-CONF-${stamp}`, 'Supplier confirmation reference');
  await c.click(confirm.getByRole('button', { name: 'Record supplier confirmation' }), 'Record supplier confirmation (confirm)');
  await expect(page.getByRole('main')).toContainText(/confirmed/i);
  finish(c);
});

test('R3 Purchase requests a supplier payment', async ({ browser }) => {
  const { dealId, reference } = await approvedDeal('R0CCPAY', 4);
  await supplierConfirmedHotel(dealId, '300000');
  const page = await signedIn(browser, 'purchase');
  const c = await fromHome(page, 'Purchase requests a supplier payment', 'R3');
  await openTask(c, page, 'Purchase tasks', reference, /^Mine/);
  await c.click(workTab(page), 'Task tab Work');
  await c.click(page.getByRole('button', { name: /^Request (advance )?payment$/ }).first(), 'Request payment');
  const drawer = page.getByRole('dialog', { name: 'Request a supplier payment' });
  await c.fill(drawer.getByLabel('Amount (₹)'), '1000', 'Amount');
  await c.upload(drawer.getByLabel('Supplier proforma or hold document'), PDF, 'Supplier proforma');
  await c.click(drawer.getByRole('button', { name: 'Send payment request' }), 'Send payment request');
  await c.click(drawer.getByRole('button', { name: 'Close' }).first(), 'Close');
  finish(c);
});

test('R3 Flight attaches e-tickets', async ({ browser }) => {
  const { dealId, reference } = await approvedDeal('R0CCFLT', 5, [['flight', FLIGHT]]);
  await ticketBatch(dealId, 5);
  const page = await signedIn(browser, 'flight');
  const c = await fromHome(page, 'Flight attaches e-tickets', 'R3');
  await openTask(c, page, 'Flight tasks', reference, /^Mine/);
  await c.click(workTab(page), 'Task tab Work');
  await c.upload(page.getByLabel('Attach e-tickets'), PDF, 'Attach e-tickets');
  await c.click(page.getByRole('button', { name: 'Attach selected files' }), 'Attach selected files');
  finish(c);
});

test('R3 Visa marks one passenger applied', async ({ browser }) => {
  const { dealId, reference } = await approvedDeal('R0CCVISA', 6, [['visa', VISA]]);
  // The desk has the task and passenger 1 is ready to apply: appointment today and every document received (not counted).
  const [task] = await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'visa' limit 1`, [dealId]);
  await asUser(USERS.visa.id, 'select public.visa_task_claim($1) as r', [task!.id]);
  const ws = await asUser<{ applicants: Array<{ applicationId: string; rowVersion: number; documents: Array<{ documentId: string }> }> }>(USERS.visa.id,
    'select public.visa_workspace($1) as r', [task!.id]);
  const first = ws.applicants[0]!;
  await asUser(USERS.visa.id, 'select public.visa_application_set_row($1, $2, $3::jsonb, $4) as r', [first.applicationId, first.rowVersion,
    JSON.stringify({ appointmentDate: istToday(), documents: first.documents.map((x) => ({ documentId: x.documentId, received: true })) }), randomUUID()]);
  const page = await signedIn(browser, 'visa');
  const c = await fromHome(page, 'Visa marks one passenger applied', 'R3');
  await openTask(c, page, 'Visa and passport tasks', reference, /^Mine/);
  await c.click(workTab(page), 'Task tab Work');
  await c.click(page.getByRole('button', { name: /^Mark as applied for / }).first(), 'Mark as applied');
  const dialog = page.getByRole('dialog', { name: 'Mark as applied' });
  await c.fill(dialog.getByLabel('Reference number'), `SYN-VISA-${stamp}`, 'Reference number');
  await c.fill(dialog.getByLabel('Government fee'), '6000', 'Government fee');
  await c.upload(dialog.getByLabel('Fee receipt'), PDF, 'Fee receipt');
  await c.click(dialog.getByRole('button', { name: 'Save as applied' }), 'Save as applied');
  finish(c);
});

test('R3 Manager approves a cost above budget', async ({ browser }) => {
  const { dealId } = await approvedDeal('R0CCMGR', 7);
  // Purchase proposes a cost above the approved budget (99,99,999.99 rupees in the booking helper).
  const [task] = await q<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase' limit 1`, [dealId]);
  const { supplierId } = await asUser<{ supplierId: string }>(USERS.purchase.id, 'select public.supplier_create($1, $2::jsonb) as r', [await entityId(),
    JSON.stringify({ name: `R0 Over Budget Stays ${stamp}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null, contactPhone: null,
      contactEmail: 'desk@example.test', paymentTerms: null, supplierKind: 'direct' })]);
  await asUser(USERS.purchase.id, 'select public.purchase_task_claim($1) as r', [task!.id]);
  const over = '199999999';
  const { quoteId } = await asUser<{ quoteId: string }>(USERS.purchase.id, 'select public.purchase_quote_add($1, $2, $3::jsonb) as r', [task!.id, randomUUID(),
    JSON.stringify({ supplierId, hotelName: HOTEL.hotelName, roomType: null, mealPlan: null, quotedCostPaise: over, holdUntil: null, cancellationTerms: null })]);
  await asUser(USERS.purchase.id, 'select public.purchase_cost_propose($1, $2, $3, $4::bigint, $5::date, $6, $7) as r', [task!.id, quoteId, 0, over, null, null,
    randomUUID()]);
  const page = await signedIn(browser, 'manager');
  const c = await fromHome(page, 'Manager approves a cost above budget', 'R3');
  await c.click(menu(page, 'Approvals'), 'menu Approvals');
  await c.click(page.getByRole('button', { name: /^Approve this cost above budget/ }).first(), 'Approve this cost above budget');
  finish(c);
});

// ---------------------------------------------------------------- R4 Accounts

/** The Deal's billing customer gets a Tally party name (same fixture step as acc3-writeoff-tally.real.e2e.ts). */
async function partyWithTallyName(dealId: string, name: string): Promise<void> {
  const e = await entityId();
  const party = (await q<{ id: string }>(`insert into public.customer_parties (legal_entity_id, party_type, name, created_by, updated_by)
    values ($1, 'personal', $2, $3, $3) returning id`, [e, `Synthetic Party ${stamp}-${name}`, USERS.sales.id]))[0]!.id;
  await q('update public.customer_billing_profiles set party_id = $2, party_copied_at = now() where deal_id = $1', [dealId, party]);
  const rv = (await q<{ v: number }>('select row_version as v from public.customer_parties where id = $1', [party]))[0]!.v;
  await asUser(USERS.accA.id, 'select public.customer_party_tally_name_set($1, $2, $3, $4) as r', [party, rv, name, randomUUID()]);
}

/** Every blank Tally mapping row gets synthetic ledger names (same fixture step as acc3-writeoff-tally.real.e2e.ts). */
async function fillMapping(): Promise<void> {
  const list = await asUser<{ rows: Array<{ mappingId: string; rowVersion: number; rowKind: string; debitLedger: string | null; creditLedger: string | null;
    voucherType: string | null }> }>(USERS.accA.id, 'select public.tally_mapping_list($1) as r', [await entityId()]);
  for (const m of list.rows) {
    if (m.debitLedger && m.creditLedger && m.voucherType) continue;
    await asUser(USERS.accA.id, 'select public.tally_mapping_set($1, $2, $3::jsonb, $4, $5) as r', [m.mappingId, m.rowVersion, JSON.stringify({
      debitLedger: m.debitLedger ?? 'Synthetic Bank A/c', creditLedger: m.creditLedger ?? 'Synthetic Customer Advances',
      voucherType: m.voucherType ?? (m.rowKind.startsWith('write_off') ? 'Journal' : 'Receipt') }), REASON, randomUUID()]);
  }
}

test('R4 Accounts verifies a receipt', async ({ browser }) => {
  const { dealId, reference } = await approvedDeal('R0CCVER', 8);
  const del = (await q<{ id: string }>(`select id from public.branches where code = 'DEL' limit 1`))[0]!.id;
  // Accounts B records a cash receipt; Accounts A (another person) verifies it.
  await asUser(USERS.accB.id, 'select public.receipt_record($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({
    mode: 'cash', amountPaise: '200000', receivedOn: istToday(), branchId: del, collectorUserId: USERS.accB.id, payerName: 'Synthetic R0 Payer',
    payerPan: `RZCCV${String(stamp % 10000).padStart(4, '0')}Q` }), randomUUID()]);
  const page = await signedIn(browser, 'accA');
  const c = await fromHome(page, 'Accounts verifies a receipt', 'R4');
  await c.click(menu(page, 'To check'), 'menu To check');
  await c.click(page.getByRole('navigation', { name: 'To check tabs' }).getByRole('link', { name: /^Receipts to verify/ }), 'tab Receipts to verify');
  await c.click(page.getByRole('main').getByRole('link', { name: new RegExp(reference) }).first(), `open ${reference}`);
  const receiptsTab = page.getByRole('navigation', { name: 'Accounts deal sections' }).getByRole('link', { name: /^Receipts/ });
  if ((await receiptsTab.getAttribute('aria-current')) !== 'page') await c.click(receiptsTab, 'Accounts deal tab Receipts');
  await c.click(page.getByRole('button', { name: 'Verify receipt' }).first(), 'Verify receipt');
  finish(c);
});

test('R4 Accounts records a receipt for a known Deal', async ({ browser }) => {
  const { reference } = await approvedDeal('R0CCREC', 9);
  const page = await signedIn(browser, 'accA');
  const c = await fromHome(page, 'Accounts records a receipt for a known Deal', 'R4');
  await c.click(menu(page, 'To check'), 'menu To check');
  await c.fill(page.getByLabel('Deal reference'), reference, 'Deal reference');
  await c.click(page.getByRole('button', { name: 'Find deal' }), 'Find deal');
  await c.click(page.getByRole('link', { name: new RegExp(`^${reference}`) }).first(), `open ${reference}`);
  const receiptsTab = page.getByRole('navigation', { name: 'Accounts deal sections' }).getByRole('link', { name: /^Receipts/ });
  if ((await receiptsTab.getAttribute('aria-current')) !== 'page') await c.click(receiptsTab, 'Accounts deal tab Receipts');
  const form = page.getByRole('form', { name: 'Record a receipt' });
  await c.click(form.getByRole('radio', { name: 'Cash' }), 'Cash');
  await c.fill(form.getByLabel('Amount received (₹)'), '1500', 'Amount received');
  await c.fill(form.getByLabel('Date received'), istToday(), 'Date received');
  await c.select(form.getByLabel('Collecting branch'), { label: 'Delhi' }, 'Collecting branch');
  await c.fill(form.getByLabel('Payer name'), 'Synthetic R0 Payer', 'Payer name');
  await c.fill(form.getByLabel('Payer PAN'), `RZCCR${String(stamp % 10000).padStart(4, '0')}Q`, 'Payer PAN');
  await c.select(form.getByLabel('Who collected the cash'), { label: USERS.accA.name }, 'Who collected the cash');
  await c.click(form.getByRole('button', { name: 'Record cash receipt' }), 'Record cash receipt');
  finish(c);
});

test('R4 Accounts releases a ready bill', async ({ browser }) => {
  const reference = `R0CCBILL-${stamp}`;
  const dealId = await freshDeal(reference);
  const v = await confirmedBooking(dealId, [['hotel', HOTEL]], 10);
  await approveBooking(dealId, v.versionId);
  const rec = await verifiedCash(dealId, '500000', 10);
  const page = await signedIn(browser, 'accA');
  // Set-up, not counted: the draft bill is made on the Deal's Documents tab, so it is ready to release.
  await page.goto(`/app/accounts/deals/${dealId}?tab=documents`);
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Customer documents' }) }).first();
  await card.getByRole('button', { name: new RegExp(`^Create draft Advance Invoice for ${rec.receiptNo}`) }).click();
  await expect(card.getByRole('button', { name: /^Release (as |this )/ }).first()).toBeVisible();
  const c = await fromHome(page, 'Accounts releases a ready bill', 'R4');
  await c.click(menu(page, 'Customer documents'), 'menu Customer documents');
  await c.click(page.getByRole('main').getByRole('row').filter({ hasText: reference }).getByRole('link', { name: /open on the Deal page/ }).first(),
    `open the bill of ${reference}`);
  await c.click(page.getByRole('button', { name: /^Release (as |this )/ }).first(), 'Release');
  await c.click(page.getByRole('dialog').getByRole('button', { name: /^Release/ }).last(), 'Release (confirm)');
  finish(c);
});

test('R4 Accounts makes the Tally file', async ({ browser }) => {
  await switchesOn3({ changes: true, serviceChanges: true, tallyXml: true });
  const { dealId } = await approvedDeal('R0CCTALLY', 11);
  await partyWithTallyName(dealId, `Synthetic Tally Customer ${stamp}`);
  await fillMapping();
  await verifiedCash(dealId, '250000', 11);
  const page = await signedIn(browser, 'accA');
  const c = await fromHome(page, 'Accounts makes the Tally file', 'R4');
  await c.click(menu(page, 'Tally'), 'menu Tally');
  const make = page.getByRole('form', { name: 'Make Tally file' });
  const today = istToday();
  if ((await make.getByLabel('From (accounting date)').inputValue()) !== today) await c.fill(make.getByLabel('From (accounting date)'), today, 'From');
  if ((await make.getByLabel('To', { exact: true }).inputValue()) !== today) await c.fill(make.getByLabel('To', { exact: true }), today, 'To');
  await c.click(make.getByRole('button', { name: 'Show what goes in' }), 'Show what goes in');
  await c.click(make.getByRole('button', { name: 'Make Tally file' }), 'Make Tally file');
  await expect(make.getByText(/^Tally file TE-/)).toBeVisible();
  finish(c);
});
