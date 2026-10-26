import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  accessTokenOf,
  authCookies,
  cspRecorder,
  enrolTotpViaUi,
  expectHardenedAuthCookies,
  finDateText,
  istToday,
  rpcAs,
  signInViaUi,
  type StoredSession,
  totpCode,
  withDb,
  writeSessionCookie,
} from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Phase 5B Milestone A section 8 (audit finding 5): the real Accounts browser
 * journey, against the disposable CI stack (Auth, Data API, Postgres and the
 * private finance-evidence Storage bucket) served by the production build.
 *
 * Two distinct Accounts people enrol TOTP through the UI: A records, B checks.
 * Covered: billing accept and correct; review return, then approve; receipt
 * record by A; self-verify refused (screen and Data API); verify by B; reject;
 * reverse; proof files in real private Storage (signed download, no public or
 * Sales read); cash pending verification; a reconciliation obligation older
 * than 90 days recorded and independently verified through the cash form;
 * future and unrelated old cash dates refused; cheque pending then cleared, another
 * bounced; concurrent cash records from two browsers against the cap; exact
 * retry and conflicting retry of the same request id through the app.
 *
 * Synthetic data only: a separate synthetic finance entity, users and dated
 * cash activity from supabase/fixtures/journeys/accounts_journey.sql, and
 * run-tagged synthetic deals and a booking created here, in the 'test'
 * deployment environment (every payment mode allowed). Local hosts only.
 *
 * Skips without a real stack; fails (never skips) when REQUIRE_REAL_STACK=1
 * and anything is missing.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && publishableKey && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error(
    'REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL, publishable key or secret key is missing: the Accounts journey must run, not skip.',
  );
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Accounts journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const BRANCH_NAME = 'Synthetic Finance Branch';
const OLD_RECEIPT_ID = 'c0000000-0000-4000-8000-0000000000f9';
const CASH_CAP_RUPEES = 49_999;
const USERS = {
  a: { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test', name: 'Synthetic Accounts Finance A' },
  b: { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test', name: 'Synthetic Accounts Finance B' },
  sales: { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test', name: 'Synthetic Sales Finance' },
} as const;
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const shotDir = 'test-results/real-journey/accounts';

const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rupees = (text: string | null) => Number((text ?? '').replace(/[^\d.]/g, ''));

/**
 * A synthetic PAN-shaped payer key unique to this run, so cash caps (per payer
 * per day, across the entity) never see an earlier run on the same stack.
 */
function runPan(tag: string, n: number): string {
  const letters = (digits: string) => [...digits].map((d) => 'ABCDEFGHIJ'[Number(d)]).join('');
  return `S${letters(tag.slice(-4, -1))}${String.fromCharCode(65 + n)}${tag.slice(-4)}Z`;
}

let shotNo = 0;
async function shot(page: Page, name: string) {
  shotNo += 1;
  await page.screenshot({ path: `${shotDir}/${String(shotNo).padStart(2, '0')}-${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
// Synthetic fixture steps (local stack only)
// ---------------------------------------------------------------------------

/** Auth users (fixed synthetic ids), then the journey fixture file once per database. */
async function loadAccountsFixture(fixtureFile: string) {
  // Label first: nothing (not even an Auth user) is created in a database that is not synthetic.
  await db(async (client) => {
    const { rows: env } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(env[0]?.environment, "the Accounts journey needs the 'test' deployment environment").toBe('test');
  });
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  for (const user of Object.values(USERS)) {
    const { error } = await admin.auth.admin.createUser({ id: user.id, email: user.email, password: fixturePassword!, email_confirm: true });
    if (error && !/already/i.test(error.message)) throw new Error(`could not create ${user.email}: ${error.message}`);
  }
  await db(async (client) => {
    const { rows: env } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(env[0]?.environment, "the Accounts journey needs the 'test' deployment environment").toBe('test');
    const { rows } = await client.query('select 1 from public.legal_entities where code = $1', [ENTITY_CODE]);
    if (rows.length === 0) {
      await client.query('begin');
      try {
        await client.query(readFileSync(fixtureFile, 'utf8'));
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    // Unknown TOTP secrets from earlier runs: every journey user enrols afresh.
    await client.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [Object.values(USERS).map((u) => u.id)]);
  });
}

/** Adds dated synthetic cash without changing an immutable receipt or the shared fixture file. */
async function seedLateCashObligation(stamp: number) {
  return db(async (client) => {
    await client.query('begin');
    try {
      const { rows: env } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id for share');
      expect(env[0]?.environment, 'dated cash fixtures require the disposable test database').toBe('test');
      const { rows } = await client.query<{ oldDate: string; unrelatedDate: string; futureDate: string }>(
        `with seed as (
           select r.* from public.customer_receipts r
           join public.deals d on d.id = r.deal_id and d.is_synthetic
           join public.legal_entities e on e.id = r.legal_entity_id and e.is_synthetic
           where r.id = $1 and r.legal_entity_id = $2 and r.mode = 'cash'
         ), dated as (
           select s.*, least(authz.finance_today() - 120,
             (select min(r.received_on) - 1 from public.customer_receipts r where r.branch_id = s.branch_id and r.mode = 'cash')) as cash_date
           from seed s
         )
         insert into public.customer_receipts
           (legal_entity_id, deal_id, branch_id, receipt_no, fiscal_year, mode, status, amount_paise, received_on,
            collector_user_id, payer_name, payer_pan, policy_version_id, request_id, recorded_by, recorded_at, note)
         select legal_entity_id, deal_id, branch_id, 'R-' || authz.finance_fiscal_year(cash_date) || '-' || $3::text,
           authz.finance_fiscal_year(cash_date), 'cash', 'recorded', 100000, cash_date,
           collector_user_id, 'Synthetic Late Cash Payer', payer_pan, policy_version_id, gen_random_uuid(), recorded_by,
           cash_date::timestamp at time zone 'Asia/Kolkata', 'SYNTHETIC FIXTURE: old cash for the browser reconciliation regression.'
         from dated
         returning to_char(received_on, 'YYYY-MM-DD') as "oldDate",
           to_char(received_on - 1, 'YYYY-MM-DD') as "unrelatedDate",
           to_char(authz.finance_today() + 1, 'YYYY-MM-DD') as "futureDate"`,
        [OLD_RECEIPT_ID, ENTITY_ID, stamp],
      );
      expect(rows, 'one dated receipt in the synthetic finance entity').toHaveLength(1);
      await client.query('commit');
      return rows[0]!;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

async function newDeal(reference: string, title: string): Promise<string> {
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
       select b.legal_entity_id, b.id, $1, $2, $3 from public.branches b
       where b.legal_entity_id = $4 and b.code = 'FBR' returning id`,
      [reference, title, USERS.sales.id, ENTITY_ID],
    );
    expect(rows, `synthetic deal ${reference}`).toHaveLength(1);
    return rows[0]!.id;
  });
}

async function rpcOk<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn} failed (${error.code ?? 'no code'}: ${error.message})`);
  return data as T;
}

/**
 * SYNTHETIC FIXTURE STEP: the Sales owner confirms a synthetic hotel booking
 * through the same database commands the booking screens call, under the
 * owner's own aal2 session (TOTP through the Auth API). Only the acceptance
 * proof object is written with the local service-role key, as the server does.
 * Returns the Sales client (aal2) for the unauthorized-read checks.
 */
async function salesConfirmsBooking(dealId: string): Promise<SupabaseClient> {
  const sales = createClient(supabaseUrl!, publishableKey!, { auth: noPersist });
  const signedIn = await sales.auth.signInWithPassword({ email: USERS.sales.email, password: fixturePassword! });
  if (signedIn.error) throw new Error(`Sales sign-in failed (${signedIn.error.status ?? 'no status'})`);
  const enrolled = await sales.auth.mfa.enroll({ factorType: 'totp', friendlyName: `accounts-journey-sales-${Date.now()}` });
  if (enrolled.error) throw new Error('Sales TOTP enrolment failed');
  const verified = await sales.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: await totpCode(enrolled.data.totp.secret) });
  if (verified.error) throw new Error('Sales TOTP verification failed');

  const opened = await rpcOk<{ versionId: string; rowVersion: number }>(sales, 'booking_open_draft', { p_deal_id: dealId });
  await rpcOk(sales, 'booking_save_draft', {
    p_version_id: opened.versionId,
    p_expected_row_version: opened.rowVersion,
    p_facts: {
      hotelName: 'Synthetic Accounts Journey Hotel',
      city: 'Synthetic City',
      checkIn: '2026-12-10',
      checkOut: '2026-12-12',
      rooms: 1,
      roomType: null,
      mealPlan: null,
      adults: 2,
      children: 0,
      inclusions: null,
      specialRequests: null,
      purchaseBudgetPaise: '3000000',
    },
    p_selling_total_paise: '7654321',
    p_selling_total_provided: true,
  });
  const proof = Buffer.from(`%PDF-1.4\n% Synthetic acceptance for the Accounts journey ${dealId}\n%%EOF\n`);
  const ev = await rpcOk<{ evidenceId: string; objectPath: string }>(sales, 'booking_begin_evidence', {
    p_version_id: opened.versionId,
    p_kind: 'acceptance_message',
    p_file_name: 'acceptance.pdf',
    p_mime: 'application/pdf',
    p_size_bytes: proof.byteLength,
    p_sha256: createHash('sha256').update(proof).digest('hex'),
  });
  const stored = await createClient(supabaseUrl!, secretKey!, { auth: noPersist })
    .storage.from('booking-evidence')
    .upload(ev.objectPath, new Blob([proof], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false });
  if (stored.error) throw new Error('acceptance proof upload failed');
  await rpcOk(sales, 'booking_finish_evidence', { p_evidence_id: ev.evidenceId, p_ok: true });
  const ready = await rpcOk<{ contentHash: string }>(sales, 'booking_readiness', { p_version_id: opened.versionId });
  await rpcOk(sales, 'booking_confirm', { p_version_id: opened.versionId, p_expected_content_hash: ready.contentHash });
  return sales;
}

// ---------------------------------------------------------------------------
// Screen steps
// ---------------------------------------------------------------------------

/**
 * Batch 4 (DA-15, plan T1): the Accounts deal page keeps its address and shows
 * one tab at a time (Money · Review · Receipts · Documents, `?tab=`). Review
 * holds the readiness, booking review and billing (lead ruling D6); Receipts
 * the receipt list and the record form; Money the money figures.
 */
type AccountsDealTab = 'money' | 'review' | 'receipts' | 'documents';
async function openDeal(page: Page, dealId: string, reference: string, tab: AccountsDealTab) {
  await page.goto(`/app/accounts/deals/${dealId}?tab=${tab}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(reference);
}

/** Approve booking (DA-275, L4): the trigger opens a confirmation dialog; the keyed form is inside it. */
async function approveBooking(page: Page) {
  await page.getByRole('region', { name: 'Booking and review' }).getByRole('button', { name: 'Approve booking' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('form', { name: 'Approve booking review' }).getByRole('button', { name: 'Yes, approve booking' }).click();
}

const doneIn = (scope: Locator) => scope.getByRole('status').filter({ hasText: 'Done:' });
const refusedIn = (scope: Locator) => scope.getByRole('alert').filter({ hasText: 'Not saved:' });

const MODE_LABEL = { bank_transfer: 'Bank transfer', upi: 'UPI', cash: 'Cash', cheque: 'Cheque' } as const;
type Mode = keyof typeof MODE_LABEL;

interface ReceiptInput {
  mode: Mode;
  amount: string;
  payerName: string;
  pan: string;
  reference?: string;
  collector?: string;
  cheque?: { number: string; micr: string; date: string };
}

/** Fills the "Record a receipt" form (does not submit). */
async function fillReceipt(page: Page, input: ReceiptInput): Promise<Locator> {
  const form = page.getByRole('form', { name: 'Record a receipt' });
  await form.getByRole('radio', { name: new RegExp(`^${MODE_LABEL[input.mode]}\\b`) }).check();
  await form.getByLabel('Amount received (₹)').fill(input.amount);
  await form.getByLabel('Date received').fill(istToday());
  await form.getByLabel('Collecting branch').selectOption({ label: BRANCH_NAME });
  if (input.mode === 'cash') await form.getByLabel('Who collected the cash').selectOption({ label: input.collector ?? USERS.a.name });
  await form.getByLabel('Payer name').fill(input.payerName);
  await form.getByLabel('Payer PAN').fill(input.pan);
  if (input.mode === 'bank_transfer' || input.mode === 'upi') {
    // Choose this run's approved account explicitly (never rely on a preselected single option).
    const select = form.getByLabel('Company account the money was paid into');
    const label = DEST[input.mode === 'upi' ? 'upi' : 'bank'].label;
    const value = await select.locator('option').filter({ hasText: label }).getAttribute('value');
    await select.selectOption(value!);
  }
  if (input.mode === 'bank_transfer') await form.getByLabel('Bank reference (UTR)').fill(input.reference!);
  if (input.mode === 'upi') await form.getByLabel('UPI transaction reference').fill(input.reference!);
  if (input.mode === 'cheque') {
    await form.getByLabel('Cheque number').fill(input.cheque!.number);
    await form.getByLabel('MICR code').fill(input.cheque!.micr);
    await form.getByLabel('Cheque date').fill(input.cheque!.date);
    await form.getByRole('checkbox', { name: /Account payee/ }).check();
  }
  return form;
}

const submitLabel = (mode: Mode) => `Record ${MODE_LABEL[mode].toLowerCase().replace('upi', 'UPI')} receipt`;

/** Records a receipt through the screen and returns its internal receipt number. */
async function recordReceipt(page: Page, input: ReceiptInput): Promise<string> {
  const form = await fillReceipt(page, input);
  await form.getByRole('button', { name: submitLabel(input.mode) }).click();
  const done = doneIn(form);
  await expect(done).toContainText('recorded (internal number). Another Accounts person must verify it.', { timeout: 30_000 });
  const receiptNo = /Receipt (R-\d{4}-\d{2}-\d{6,})/.exec((await done.textContent()) ?? '')?.[1];
  expect(receiptNo, 'receipt number in the confirmation').toBeTruthy();
  return receiptNo!;
}

function receiptCard(page: Page, receiptNo: string): Locator {
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 3, name: new RegExp(`^${esc(receiptNo)} · `) }) });
}

// Stage 2: company accounts (synthetic labels without digits: labels may not carry account numbers).
// Labels are unique per run (letters only), so a re-run or another suite's
// leftovers on the same stack can never be confused with this run's accounts.
const RUN_LETTERS = String(Date.now()).slice(-6).replace(/[0-9]/g, (d) => 'ABCDEFGHIJ'[Number(d)]!);
const DEST = {
  bank: { label: `Synthetic journey bank ${RUN_LETTERS}`, account: '000123456789', masked: 'XXXX6789' },
  upi: { label: `Synthetic journey UPI ${RUN_LETTERS}`, upiId: 'synthetic.journey@synbank', masked: 's***@synbank' },
} as const;

function destinationCard(page: Page, label: string): Locator {
  return page.getByRole('list', { name: 'Company accounts' }).getByRole('listitem')
    .filter({ has: page.getByRole('heading', { level: 3, name: label, exact: true }) });
}

/** A submits one company account through the Add form (synthetic values only). */
async function submitDestination(page: Page, kind: 'bank' | 'upi') {
  await page.goto('/app/accounts/destinations');
  // The Add form is open on an empty page and collapsed once accounts exist; a role
  // locator never matches a form inside a closed <details>, so check visibility instead.
  const form = page.getByRole('form', { name: 'Add a company account' });
  if (!(await form.isVisible())) await page.locator('summary').filter({ hasText: 'Add a bank account or UPI ID' }).click();
  await expect(form).toBeVisible();
  await form.getByRole('radio', { name: kind === 'bank' ? 'Bank account' : 'UPI ID' }).check();
  await form.getByLabel('Internal name').fill(DEST[kind].label);
  if (kind === 'bank') {
    await form.getByLabel('Account holder name').fill('Synthetic Holidays Journey');
    await form.getByLabel('Bank name').fill('Synthetic Bank');
    await form.getByLabel('Account number').fill(DEST.bank.account);
    await form.getByLabel('IFSC').fill('SYNB0001234');
  } else {
    await form.getByLabel('Payee name').fill('Synthetic Holidays Journey');
    await form.getByRole('textbox', { name: 'UPI ID', exact: true }).fill(DEST.upi.upiId);
  }
  await form.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(destinationCard(page, DEST[kind].label)).toContainText('Waiting for approval', { timeout: 30_000 });
}

async function openSummary(scope: Locator, text: string) {
  await scope.locator('summary').filter({ hasText: text }).first().click();
}

const PROOF_LABEL = { bank_proof: 'Bank proof (statement line or credit advice)', cheque_image: 'Cheque image' } as const;

/** Uploads a small synthetic PDF as proof for a receipt (real private Storage through the server). */
async function uploadProof(page: Page, receiptNo: string, kind: keyof typeof PROOF_LABEL, fileName: string, stamp: number) {
  const card = receiptCard(page, receiptNo);
  await openSummary(card, 'Upload proof');
  const form = page.getByRole('form', { name: `Upload proof for ${receiptNo}` });
  await form.getByLabel('What is this file?').selectOption({ label: PROOF_LABEL[kind] });
  await form.getByLabel('File', { exact: true }).setInputFiles({
    name: fileName,
    mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.4\n% Synthetic ${kind} for ${receiptNo}, run ${stamp}. Not a real payment.\n%%EOF\n`),
  });
  await form.getByRole('button', { name: 'Upload file' }).click();
  await expect(receiptCard(page, receiptNo).getByRole('list', { name: 'Proof files' })).toContainText(fileName, { timeout: 30_000 });
}

// Actions on a receipt re-render its card, and the action form leaves the page once the
// receipt changes state, so the "Done:" message is transient. Assert the card's state instead.
async function verifyReceipt(page: Page, receiptNo: string, cardState: string) {
  const form = page.getByRole('form', { name: `Verify ${receiptNo}` });
  await form.getByRole('button', { name: /Verify receipt/ }).click();
  await expect(receiptCard(page, receiptNo)).toContainText(cardState, { timeout: 30_000 });
}

async function reasonAction(
  page: Page,
  receiptNo: string,
  title: string,
  opts: { kind?: string; date?: string; text?: string; textLabel?: string; submit: string; cardState: string },
) {
  await openSummary(receiptCard(page, receiptNo), title);
  const form = page.getByRole('form', { name: `${title} ${receiptNo}` });
  if (opts.kind) await form.getByLabel('What happened').selectOption({ label: opts.kind });
  if (opts.date) await form.getByLabel('Date of the outcome').fill(opts.date);
  if (opts.text) await form.getByLabel(opts.textLabel ?? 'Reason').fill(opts.text);
  await form.getByRole('button', { name: opts.submit }).click();
  await expect(receiptCard(page, receiptNo)).toContainText(opts.cardState, { timeout: 30_000 });
}

async function receiptIdOf(receiptNo: string): Promise<string> {
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>('select id from public.customer_receipts where legal_entity_id = $1 and receipt_no = $2', [ENTITY_ID, receiptNo]);
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  });
}

async function signInAndEnrol(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');
  return page;
}

function cashFigure(page: Page, label: string): Locator {
  return page.getByRole('region', { name: BRANCH_NAME, exact: true }).locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
}

// ---------------------------------------------------------------------------

test.describe('real Accounts browser journey (Phase 5B Milestone A section 8)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and keys).');
  test.describe.configure({ mode: 'serial' });

  test('two Accounts people: billing, review, receipts, cheques, cash custody, caps and retries', async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    mkdirSync(shotDir, { recursive: true });
    const stamp = Date.now();
    const tag = String(stamp).slice(-8);
    const csp = cspRecorder();
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');

    const deal1 = { ref: `SYN-FIN-${tag}-1`, title: 'Synthetic Accounts journey deal (booking)' };
    const deal2 = { ref: `SYN-FIN-${tag}-2`, title: 'Synthetic Accounts journey deal (receipts)' };
    const deal3 = { ref: `SYN-FIN-${tag}-3`, title: 'Synthetic Accounts journey deal (cash cap)' };

    const { ids, salesClient, lateCash } = await test.step('fixture: synthetic finance entity, two Accounts people, deals and a confirmed booking', async () => {
      await loadAccountsFixture(fixtureFile);
      const lateCash = await seedLateCashObligation(stamp);
      const ids = { d1: await newDeal(deal1.ref, deal1.title), d2: await newDeal(deal2.ref, deal2.title), d3: await newDeal(deal3.ref, deal3.title) };
      const salesClient = await salesConfirmsBooking(ids.d1);
      return { ids, salesClient, lateCash };
    });

    const ctxA = await csp.track(browser, 'accounts-a');
    const ctxB = await csp.track(browser, 'accounts-b');
    const { a, b } = await test.step('both Accounts people sign in and enrol TOTP through the UI (aal2)', async () => {
      const a = await signInAndEnrol(ctxA, USERS.a.email);
      const b = await signInAndEnrol(ctxB, USERS.b.email);
      await expectHardenedAuthCookies(ctxA, false);
      await expectHardenedAuthCookies(ctxB, false);
      return { a, b };
    });

    await test.step('company accounts: A submits a bank account and a UPI ID; A cannot approve them; B approves both', async () => {
      await submitDestination(a, 'bank');
      await submitDestination(a, 'upi');
      for (const kind of ['bank', 'upi'] as const) {
        const own = destinationCard(a, DEST[kind].label);
        await expect(own.getByRole('form', { name: `Approve version 1 of ${DEST[kind].label}` })).toHaveCount(0);
        await expect(own).toContainText('Another Accounts person must approve or return it.');
        await expect(own).not.toContainText(kind === 'bank' ? DEST.bank.account : DEST.upi.upiId);
      }
      await shot(a, 'company-accounts-submitted');
      await b.goto('/app/accounts/destinations');
      for (const kind of ['bank', 'upi'] as const) {
        const card = destinationCard(b, DEST[kind].label);
        await card.getByRole('form', { name: `Approve version 1 of ${DEST[kind].label}` }).getByRole('button', { name: /Approve version 1/ }).click();
        await expect(destinationCard(b, DEST[kind].label)).toContainText('Approved, in use', { timeout: 30_000 });
        await expect(destinationCard(b, DEST[kind].label)).toContainText(DEST[kind].masked);
      }
      const rows = await db(async (client) => (await client.query<{ maker: string; decided_by: string }>(
        `select v.maker, v.decided_by from public.company_destination_versions v
         join public.company_destinations d on d.id = v.destination_id
         where d.legal_entity_id = $1 and v.status = 'approved' and d.label = any($2::text[])`,
        [ENTITY_ID, [DEST.bank.label, DEST.upi.label]],
      )).rows);
      expect(rows).toEqual([{ maker: USERS.a.id, decided_by: USERS.b.id }, { maker: USERS.a.id, decided_by: USERS.b.id }]);
      await shot(b, 'company-accounts-approved');
    });

    await test.step('B opens the full bank details: values only in that response, recorded in the audit trail', async () => {
      const card = destinationCard(b, DEST.bank.label);
      await openSummary(card, 'Version history');
      const show = card.getByRole('form', { name: `Show full details of version 1 of ${DEST.bank.label}` });
      await show.getByRole('button', { name: /Show full details/ }).click();
      await expect(card.getByRole('definition').filter({ hasText: DEST.bank.account })).toBeVisible({ timeout: 30_000 });
      expect(b.url()).not.toContain(DEST.bank.account);
      const audit = await db(async (client) => (await client.query<{ details: string }>(
        `select a.details::text as details from public.audit_events a
         join public.company_destinations d on d.id = a.target_id
         where a.action = 'finance.destination_viewed' and a.actor_user_id = $1 and d.label = $2`, [USERS.b.id, DEST.bank.label],
      )).rows);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).not.toContain(DEST.bank.account);
    });

    await test.step('queue lists the booked deal; exact lookup finds a deal with nothing recorded yet', async () => {
      await a.goto('/app/accounts');
      // DA-274: "To check", default tab Booking reviews (deal 1's booking waits for review; deal 2 has none).
      await expect(a.getByRole('heading', { level: 1, name: 'To check' })).toBeVisible();
      await expect(a.getByRole('row').filter({ hasText: deal1.ref })).toContainText('Confirmed');
      await expect(a.getByRole('row').filter({ hasText: deal2.ref })).toHaveCount(0);
      await a.getByLabel('Deal reference').fill(deal2.ref);
      await a.getByRole('button', { name: 'Find deal' }).click();
      await expect(a.getByRole('link', { name: new RegExp(`^${esc(deal2.ref)} · `) })).toBeVisible();
      await shot(a, 'queue-and-lookup');
    });

    await test.step('review cannot be approved before billing is verified; A returns it to Sales with a reason', async () => {
      await openDeal(a, ids.d1, deal1.ref, 'review');
      const booking = a.getByRole('region', { name: 'Booking and review' });
      await expect(booking).toContainText('Waiting for Accounts review');
      await expect(booking.getByRole('button', { name: 'Approve booking' })).toHaveAttribute('aria-disabled', 'true');
      await expect(booking).toContainText('Verify the customer billing details before approving the review.');
      await openSummary(booking, 'Return to Sales with a reason');
      const form = a.getByRole('form', { name: 'Return booking review' });
      await form.getByLabel('Reason').fill('Synthetic journey: check-in date differs from the voucher');
      await form.getByRole('button', { name: 'Return review' }).click();
      await expect(a.getByRole('region', { name: 'Booking and review' })).toContainText('Returned to Sales', { timeout: 30_000 });
      await shot(a, 'review-returned');
    });

    await test.step('billing: A enters details, B verifies them (accept)', async () => {
      const form = a.getByRole('form', { name: 'Customer billing details' });
      await form.getByLabel('Billing name').fill('Synthetic Customer Billing Name');
      await form.getByLabel('Address line 1').fill('1 Synthetic Street');
      await form.getByLabel('City').fill('Jodhpur');
      await form.getByLabel('State code').fill('08');
      await form.getByLabel('PIN code').fill('342001');
      await form.getByRole('button', { name: 'Save billing details' }).click();
      // The action revalidates the page and the form re-mounts (or disappears once done), so the
      // persistent page state is asserted rather than the transient "Done:" message.
      await expect(a.getByRole('region', { name: 'Customer billing details' })).toContainText('Saved, not verified', { timeout: 30_000 });

      await openDeal(b, ids.d1, deal1.ref, 'review');
      const verify = b.getByRole('form', { name: 'Check billing details' });
      await verify.getByRole('button', { name: 'Check billing details' }).click();
      await expect(b.getByRole('region', { name: 'Customer billing details' })).toContainText('Billing details: Verified', { timeout: 30_000 });
    });

    await test.step('the returned review is approved once billing is verified', async () => {
      await openDeal(a, ids.d1, deal1.ref, 'review');
      await approveBooking(a);
      await expect(a.getByRole('region', { name: 'Booking and review' })).toContainText('Approved by Accounts', { timeout: 30_000 });
      await shot(a, 'review-approved');
    });

    await test.step('billing correction: saving puts billing and review back to waiting; B verifies and approves again', async () => {
      const billing = a.getByRole('region', { name: 'Customer billing details' });
      await openSummary(billing, 'Edit billing details');
      const form = a.getByRole('form', { name: 'Customer billing details' });
      await form.getByLabel('Address line 1').fill('2 Synthetic Street (corrected)');
      await form.getByRole('button', { name: 'Save billing details' }).click();
      // The action revalidates the page and the form re-mounts (or disappears once done), so the
      // persistent page state is asserted rather than the transient "Done:" message.
      await expect(a.getByRole('region', { name: 'Customer billing details' })).toContainText('Saved, not verified', { timeout: 30_000 });
      await expect(a.getByRole('region', { name: 'Booking and review' })).toContainText('Waiting for Accounts review');

      await openDeal(b, ids.d1, deal1.ref, 'review');
      await expect(b.getByRole('region', { name: 'Customer billing details' })).toContainText('2 Synthetic Street (corrected)');
      const verify = b.getByRole('form', { name: 'Check billing details' });
      await verify.getByRole('button', { name: 'Check billing details' }).click();
      await expect(b.getByRole('region', { name: 'Customer billing details' })).toContainText('Billing details: Verified', { timeout: 30_000 });
      await approveBooking(b);
      await expect(b.getByRole('region', { name: 'Booking and review' })).toContainText('Approved by Accounts', { timeout: 30_000 });
      await shot(b, 'billing-corrected-and-approved');
    });

    const bankNo = await test.step('A records a bank transfer and uploads the bank proof to private Storage', async () => {
      await openDeal(a, ids.d1, deal1.ref, 'receipts');
      const no = await recordReceipt(a, { mode: 'bank_transfer', amount: '10000', payerName: 'Synthetic Bank Payer', pan: 'SYNBA0001A', reference: `SYNUTR${tag}` });
      await expect(receiptCard(a, no)).toContainText('Awaiting verification');
      await uploadProof(a, no, 'bank_proof', `bank-proof-${tag}.pdf`, stamp);
      await expect(receiptCard(a, no)).toContainText('Stored');
      // The single approved bank account was preselected and its snapshot is on the receipt.
      await expect(receiptCard(a, no)).toContainText(`${DEST.bank.label} · Bank account · Synthetic Bank ${DEST.bank.masked} · version 1`);
      return no;
    });

    await test.step('self-verify is refused: no verify form for A, and the Data API refuses A too', async () => {
      const card = receiptCard(a, bankNo);
      await expect(a.getByRole('form', { name: `Verify ${bankNo}` })).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Verify receipt' })).toHaveAttribute('aria-disabled', 'true');
      await expect(card).toContainText('You recorded this receipt. Another Accounts person must do this step.');
      const refused = await rpcAs(supabaseUrl!, publishableKey!, await accessTokenOf(ctxA), 'receipt_verify', {
        p_receipt_id: await receiptIdOf(bankNo),
        p_request_id: crypto.randomUUID(),
      });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.body.message).toBe('not_self_approval');
      await shot(a, 'self-verify-refused');
    });

    await test.step('B verifies the bank transfer; it counts as available', async () => {
      await openDeal(b, ids.d1, deal1.ref, 'receipts');
      await verifyReceipt(b, bankNo, 'Receipt status: Verified');
      await expect(receiptCard(b, bankNo)).toContainText('Verified');
      await openDeal(b, ids.d1, deal1.ref, 'money');
      await expect(b.getByRole('region', { name: 'Money for this deal' })).toContainText('₹10,000.00');
    });

    await test.step('proof is in private Storage: a short-lived signed download for Accounts, nothing public, nothing for Sales', async () => {
      await openDeal(b, ids.d1, deal1.ref, 'receipts');
      const link = receiptCard(b, bankNo).getByRole('link', { name: `bank-proof-${tag}.pdf` });
      const href = (await link.getAttribute('href')) ?? '';
      expect(href).toMatch(/^\/app\/accounts\/files\/[0-9a-f-]{36}$/);
      const redirect = await b.request.get(href, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
      const location = redirect.headers()['location'] ?? '';
      expect(new URL(location).origin).toBe(new URL(supabaseUrl!).origin);
      expect(isLoopbackUrl(location), 'the app under test uses the loopback stack').toBe(true);
      const file = await fetch(location);
      expect(file.status).toBe(200);
      expect(await file.text()).toContain(`Synthetic bank_proof for ${bankNo}`);

      const objectPath = await db(async (client) => {
        const { rows } = await client.query<{ object_path: string }>(
          `select e.object_path from public.finance_evidence e join public.customer_receipts r on r.id = e.receipt_id
           where r.legal_entity_id = $1 and r.receipt_no = $2 and e.status = 'stored'`,
          [ENTITY_ID, bankNo],
        );
        return rows[0]!.object_path;
      });
      const publicRead = await fetch(`${supabaseUrl}/storage/v1/object/public/finance-evidence/${objectPath}`);
      expect(publicRead.status, 'the bucket is private').not.toBe(200);
      const { data: salesSession } = await salesClient.auth.getSession();
      const salesRead = await fetch(`${supabaseUrl}/storage/v1/object/authenticated/finance-evidence/${objectPath}`, {
        headers: { apikey: publishableKey!, Authorization: `Bearer ${salesSession.session!.access_token}` },
      });
      expect(salesRead.status, 'Sales cannot read finance proof').not.toBe(200);
      const salesQueue = await salesClient.rpc('accounts_queue', { p_filter: 'all' });
      expect(salesQueue.error?.message).toBe('not_authorized');
      const salesDetail = await salesClient.rpc('accounts_deal_detail', { p_deal_id: ids.d1 });
      expect(salesDetail.error ? salesDetail.error.message : salesDetail.data).toEqual(salesDetail.error ? 'not_authorized' : null);
      // A file id that is not visible looks exactly like a missing one: a plain 404.
      const missing = await b.request.get('/app/accounts/files/00000000-0000-4000-8000-000000000000', { maxRedirects: 0 });
      expect(missing.status()).toBe(404);
    });

    await test.step('A reverses the receipt B verified (no refund; both stay in the history)', async () => {
      await openDeal(a, ids.d1, deal1.ref, 'receipts');
      await expect(receiptCard(a, bankNo).getByRole('button', { name: 'Verify receipt' })).toHaveCount(0);
      await reasonAction(a, bankNo, 'Reverse receipt', {
        kind: 'Returned by the bank',
        text: 'Synthetic journey: the bank returned the credit',
        submit: 'Reverse receipt',
        cardState: 'Reversed (returned by the bank)',
      });
      await expect(receiptCard(a, bankNo)).toContainText('Reversed (returned by the bank)');
      await shot(a, 'receipt-reversed');
    });

    await test.step('A records a UPI receipt; B rejects it as money not received', async () => {
      await openDeal(a, ids.d2, deal2.ref, 'receipts');
      const upiNo = await recordReceipt(a, { mode: 'upi', amount: '5000', payerName: 'Synthetic UPI Payer', pan: 'SYNUP0001U', reference: `SYNUPI${tag}` });
      await openDeal(b, ids.d2, deal2.ref, 'receipts');
      await reasonAction(b, upiNo, 'Reject receipt', {
        kind: 'Money not received',
        text: 'Synthetic journey: no credit on the statement',
        submit: 'Reject receipt',
        cardState: 'Rejected (money not received)',
      });
      await expect(receiptCard(b, upiNo)).toContainText('Rejected (money not received)');
    });

    await test.step('cash pending verification is shown separately on the branch cash page', async () => {
      await a.goto('/app/accounts/cash');
      await expect(a.getByRole('heading', { level: 1, name: 'Branch cash' })).toBeVisible();
      const before = rupees(await cashFigure(a, 'Cash recorded, not verified').textContent());
      await openDeal(a, ids.d2, deal2.ref, 'receipts');
      const cashNo = await recordReceipt(a, { mode: 'cash', amount: '2500', payerName: 'Synthetic Cash Payer', pan: runPan(tag, 2) });
      await expect(receiptCard(a, cashNo)).toContainText('Awaiting verification');
      await a.goto('/app/accounts/cash');
      await expect.poll(async () => rupees(await cashFigure(a, 'Cash recorded, not verified').textContent())).toBe(before + 2500);
      await shot(a, 'cash-pending-verification');
    });

    await test.step('a missing cash count older than 90 days is still outstanding, with complete totals', async () => {
      const { oldDate } = lateCash;
      const ageDays = Math.round((Date.parse(`${istToday()}T00:00:00Z`) - Date.parse(`${oldDate}T00:00:00Z`)) / 86_400_000);
      expect(ageDays, 'the fixture cash activity is older than 90 days').toBeGreaterThan(90);
      const branch = b.getByRole('region', { name: BRANCH_NAME, exact: true });
      await b.goto('/app/accounts/cash');
      await expect(branch).toContainText('Daily cash count missing');
      await expect(branch).toContainText(`oldest ${finDateText(oldDate)}`);
      await expect(branch.getByRole('list', { name: /Daily cash count missing/ })).toContainText(finDateText(oldDate));
      await expect(branch).not.toContainText('Nothing unresolved at this branch');
      await shot(b, 'reconciliation-older-than-90-days');
    });

    await test.step('the cash form refuses a future date and an unrelated date older than 90 days', async () => {
      await a.goto('/app/accounts/cash');
      const branch = a.getByRole('region', { name: BRANCH_NAME, exact: true });
      await openSummary(branch, 'Record a daily cash count');
      const form = branch.getByRole('form', { name: `Record a daily cash count for ${BRANCH_NAME}` });
      await form.getByLabel('Business date').fill(lateCash.futureDate);
      await form.getByLabel('Cash counted (₹)').fill('0');
      await form.getByRole('button', { name: 'Record cash count', exact: true }).click();
      await expect(refusedIn(form)).toBeVisible({ timeout: 30_000 });
      await expect(form.getByLabel('Business date')).toHaveValue(lateCash.futureDate);
      await expect(form.getByLabel('Business date')).toHaveAttribute('aria-invalid', 'true');

      await form.getByLabel('Business date').fill(lateCash.unrelatedDate);
      await form.getByRole('button', { name: 'Record cash count', exact: true }).click();
      await expect(refusedIn(form)).toContainText('Some details are missing or not in the expected format', { timeout: 30_000 });
      await expect(form.getByLabel('Business date')).toHaveValue(lateCash.unrelatedDate);
      const rows = await db(async (client) => (await client.query(
        `select c.id from public.cash_reconciliations c join public.branches b on b.id = c.branch_id
         where b.legal_entity_id = $1 and b.code = 'FBR' and c.business_date = any($2::date[])`,
        [ENTITY_ID, [lateCash.futureDate, lateCash.unrelatedDate]],
      )).rows);
      expect(rows, 'refused cash dates create no reconciliation').toEqual([]);
    });

    await test.step('A records the old obligation through the form; B verifies it and clears only that date', async () => {
      await a.goto('/app/accounts/cash');
      const branchA = a.getByRole('region', { name: BRANCH_NAME, exact: true });
      await openSummary(branchA, 'Record a daily cash count');
      const form = branchA.getByRole('form', { name: `Record a daily cash count for ${BRANCH_NAME}` });
      await form.getByLabel('Business date').fill(lateCash.oldDate);
      // The dated fixture is unverified: the expected posted cash balance is zero.
      await form.getByLabel('Cash counted (₹)').fill('0');
      await form.getByRole('button', { name: 'Record cash count', exact: true }).click();
      const countsA = branchA.getByRole('list', { name: `Daily cash counts at ${BRANCH_NAME}` });
      const countA = countsA.locator(':scope > li').filter({ hasText: finDateText(lateCash.oldDate) });
      await expect(countA).toContainText('Awaiting verification', { timeout: 30_000 });
      await expect(countA.getByRole('button', { name: 'Verify cash count', exact: true })).toHaveAttribute('aria-disabled', 'true');
      await expect(branchA.getByRole('list', { name: /Daily cash count awaiting verification/ })).toContainText(finDateText(lateCash.oldDate));

      await b.goto('/app/accounts/cash');
      const branchB = b.getByRole('region', { name: BRANCH_NAME, exact: true });
      const countB = branchB.getByRole('list', { name: `Daily cash counts at ${BRANCH_NAME}` })
        .locator(':scope > li').filter({ hasText: finDateText(lateCash.oldDate) });
      const verify = countB.getByRole('form', { name: `Verify cash count for ${lateCash.oldDate}` });
      await verify.getByRole('button', { name: /Verify cash count/ }).click();
      await expect(countB).toContainText('Cash count: Verified', { timeout: 30_000 });
      await expect(branchB.getByRole('list', { name: /Daily cash count awaiting verification/ })).toHaveCount(0);
      await expect(branchB.getByRole('list', { name: /Daily cash count missing/ })).not.toContainText(finDateText(lateCash.oldDate));
      await expect(branchB).not.toContainText('Nothing unresolved at this branch');
      const rows = await db(async (client) => (await client.query(
        `select c.status, c.recorded_by, c.verified_by from public.cash_reconciliations c
         join public.branches b on b.id = c.branch_id
         where b.legal_entity_id = $1 and b.code = 'FBR' and c.business_date = $2::date and not c.stale`,
        [ENTITY_ID, lateCash.oldDate],
      )).rows);
      expect(rows).toEqual([{ status: 'verified', recorded_by: USERS.a.id, verified_by: USERS.b.id }]);
      await shot(b, 'old-reconciliation-verified');
    });

    await test.step('deposit: A deposits verified cash with a slip; B opens the slip through the private link and verifies; others cannot', async () => {
      await openDeal(a, ids.d2, deal2.ref, 'receipts');
      const cashNo = await recordReceipt(a, { mode: 'cash', amount: '2000', payerName: 'Synthetic Deposit Payer', pan: runPan(tag, 3) });
      await openDeal(b, ids.d2, deal2.ref, 'receipts');
      await verifyReceipt(b, cashNo, 'Receipt status: Verified');

      const bankRef = `SYNDEP${tag}`;
      const slipName = `deposit-slip-${tag}.pdf`;
      await a.goto('/app/accounts/cash');
      const branchA = a.getByRole('region', { name: BRANCH_NAME, exact: true });
      await openSummary(branchA, 'Record a bank deposit');
      const form = branchA.getByRole('form', { name: `Record a bank deposit for ${BRANCH_NAME}` });
      // Deposit only this run's receipt; other verified fixture cash stays in custody.
      for (const box of await form.getByRole('checkbox').all()) await box.uncheck();
      await form.getByRole('checkbox', { name: new RegExp(`^${esc(cashNo)} `) }).check();
      await form.getByLabel('Deposited on').fill(istToday());
      await form.getByLabel('Bank reference on the slip').fill(bankRef);
      await form.getByLabel('Deposit slip').setInputFiles({
        name: slipName,
        mimeType: 'application/pdf',
        buffer: Buffer.from(`%PDF-1.4\n% Synthetic deposit_slip for ${bankRef}, run ${stamp}. Not a real deposit.\n%%EOF\n`),
      });
      await form.getByRole('button', { name: 'Record deposit' }).click();
      const depositsA = branchA.getByRole('list', { name: `Bank deposits at ${BRANCH_NAME}` });
      const cardA = depositsA.locator(':scope > li').filter({ hasText: bankRef });
      await expect(cardA).toContainText('Deposit: Awaiting verification', { timeout: 30_000 });
      await expect(cardA.getByRole('list', { name: `Deposit slip for ${bankRef}` })).toContainText(slipName);
      await expect(cardA).toContainText('works for 60 seconds');

      await b.goto('/app/accounts/cash');
      const branchB = b.getByRole('region', { name: BRANCH_NAME, exact: true });
      const cardB = branchB.getByRole('list', { name: `Bank deposits at ${BRANCH_NAME}` }).locator(':scope > li').filter({ hasText: bankRef });
      const link = cardB.getByRole('list', { name: `Deposit slip for ${bankRef}` }).getByRole('link', { name: slipName });
      const href = (await link.getAttribute('href')) ?? '';
      expect(href).toMatch(/^\/app\/accounts\/files\/[0-9a-f-]{36}$/);
      const evidenceId = href.split('/').pop()!;

      // The checker opens the real slip: re-authorized, then a short-lived signed Storage URL.
      const redirect = await b.request.get(href, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
      const location = redirect.headers()['location'] ?? '';
      expect(new URL(location).origin).toBe(new URL(supabaseUrl!).origin);
      const file = await fetch(location);
      expect(file.status).toBe(200);
      expect(await file.text()).toContain(`Synthetic deposit_slip for ${bankRef}`);
      // Opening it again mints a fresh link (an expired one is repaired by re-opening from the page).
      const again = await b.request.get(href, { maxRedirects: 0 });
      expect(again.status()).toBe(302);

      // No session: sent to sign-in, never to Storage.
      const anon = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
      const anonRes = await anon.request.get(href, { maxRedirects: 0 });
      expect([302, 303, 307, 308]).toContain(anonRes.status());
      expect(anonRes.headers()['location'] ?? '').toMatch(/\/sign-in/);
      await anon.close();
      // Sales with a full aal2 session (the fixture's own session placed in a browser): the route
      // answers the same readable 404 as a missing file. Purchase and Accounts+Purchase holders are
      // refused by the same command (tests/db/finance-access-roles.test.ts).
      const salesCtx = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
      await salesCtx.addCookies(await authCookies(ctxB));
      const { data: salesSession } = await salesClient.auth.getSession();
      await writeSessionCookie(salesCtx, salesSession.session as unknown as StoredSession);
      const salesRes = await salesCtx.request.get(href, { maxRedirects: 0 });
      expect(salesRes.status()).toBe(404);
      expect(await salesRes.text()).toContain('This file does not exist or you cannot open it.');
      await salesCtx.close();
      const salesAttempt = await salesClient.rpc('finance_evidence_authorize_download', { p_evidence_id: evidenceId });
      expect(salesAttempt.error?.message).toBe('not_authorized');
      const objectPath = await db(async (client) => (await client.query<{ object_path: string }>(
        `select object_path from public.finance_evidence where id = $1 and kind = 'deposit_slip' and status = 'stored'`, [evidenceId],
      )).rows[0]!.object_path);
      const publicRead = await fetch(`${supabaseUrl}/storage/v1/object/public/finance-evidence/${objectPath}`);
      expect(publicRead.status, 'the bucket is private').not.toBe(200);

      const verify = cardB.getByRole('form', { name: `Verify deposit ${bankRef}` });
      await verify.getByRole('button', { name: /Verify deposit/ }).click();
      await expect(cardB).toContainText('Deposit: Verified', { timeout: 30_000 });
      const audit = await db(async (client) => (await client.query<{ n: number }>(
        `select count(*)::int as n from public.audit_events
         where action = 'finance.evidence_viewed' and target_id = $1 and actor_user_id = $2`, [evidenceId, USERS.b.id],
      )).rows[0]!.n);
      expect(audit, 'each authorized opening is audited').toBeGreaterThanOrEqual(2);
      await shot(b, 'deposit-slip-opened-and-verified');
    });

    await test.step('cheque: A records it with the image; B verifies (pending clearance), adds bank proof and records it cleared', async () => {
      await openDeal(a, ids.d2, deal2.ref, 'receipts');
      const no = await recordReceipt(a, {
        mode: 'cheque',
        amount: '15000',
        payerName: 'Synthetic Cheque Payer',
        pan: 'SYNCH0001Q',
        cheque: { number: tag.slice(-6), micr: '110002001', date: istToday() },
      });
      await expect(receiptCard(a, no)).toContainText('Cheque recorded, awaiting verification');
      await uploadProof(a, no, 'cheque_image', `cheque-image-${tag}.pdf`, stamp);
      await openDeal(b, ids.d2, deal2.ref, 'receipts');
      await verifyReceipt(b, no, 'Cheque awaiting bank clearance');
      await expect(receiptCard(b, no)).toContainText('Cheque awaiting bank clearance');
      await uploadProof(b, no, 'bank_proof', `cheque-credit-${tag}.pdf`, stamp);
      await openSummary(receiptCard(b, no), 'Record cheque cleared');
      const clear = b.getByRole('form', { name: `Record cheque cleared ${no}` });
      await clear.getByLabel('Date the bank cleared it').fill(istToday());
      await clear.getByRole('button', { name: 'Record cheque cleared' }).click();
      await expect(receiptCard(b, no)).toContainText('Cleared', { timeout: 30_000 });
      await shot(b, 'cheque-cleared');
    });

    await test.step('another cheque bounces: B records the outcome with the bank memo', async () => {
      await openDeal(a, ids.d2, deal2.ref, 'receipts');
      const no = await recordReceipt(a, {
        mode: 'cheque',
        amount: '12000',
        payerName: 'Synthetic Bounced Cheque Payer',
        pan: 'SYNCH0002Q',
        cheque: { number: String((Number(tag.slice(-6)) + 1) % 1_000_000).padStart(6, '0'), micr: '110002001', date: istToday() },
      });
      await uploadProof(a, no, 'cheque_image', `cheque2-image-${tag}.pdf`, stamp);
      await openDeal(b, ids.d2, deal2.ref, 'receipts');
      await verifyReceipt(b, no, 'Cheque awaiting bank clearance');
      await uploadProof(b, no, 'bank_proof', `cheque2-return-memo-${tag}.pdf`, stamp);
      await reasonAction(b, no, 'Record cheque not honoured', {
        kind: 'Bounced',
        date: istToday(),
        text: 'Synthetic journey: insufficient funds memo',
        textLabel: 'Note (needed for a cancelled cheque)',
        submit: 'Record outcome',
        cardState: 'Cheque bounced',
      });
      await expect(receiptCard(b, no)).toContainText('Cheque bounced');
      await shot(b, 'cheque-bounced');
    });

    await test.step('two browsers record cash for one payer at the same moment: the cap admits exactly one', async () => {
      const pan = runPan(tag, 10);
      await openDeal(a, ids.d3, deal3.ref, 'receipts');
      await openDeal(b, ids.d3, deal3.ref, 'receipts');
      const amount = String(Math.floor(CASH_CAP_RUPEES * 0.6));
      const formA = await fillReceipt(a, { mode: 'cash', amount, payerName: 'Synthetic Capped Payer', pan, collector: USERS.a.name });
      const formB = await fillReceipt(b, { mode: 'cash', amount, payerName: 'Synthetic Capped Payer', pan, collector: USERS.b.name });
      await Promise.all([
        formA.getByRole('button', { name: submitLabel('cash') }).click(),
        formB.getByRole('button', { name: submitLabel('cash') }).click(),
      ]);
      const outcome = async (form: Locator) => {
        await expect(doneIn(form).or(refusedIn(form))).toBeVisible({ timeout: 30_000 });
        return (await doneIn(form).count()) > 0 ? 'done' : ((await refusedIn(form).textContent()) ?? '');
      };
      const results = [await outcome(formA), await outcome(formB)];
      expect(results.filter((r) => r === 'done')).toHaveLength(1);
      expect(results.find((r) => r !== 'done')).toMatch(/over the company cash limit/);
      const total = await db(async (client) => {
        const { rows } = await client.query<{ n: number; s: string }>(
          `select count(*)::int as n, coalesce(sum(amount_paise), 0)::text as s from public.customer_receipts
           where deal_id = $1 and mode = 'cash' and payer_pan = $2`,
          [ids.d3, pan],
        );
        return rows[0]!;
      });
      expect(total.n).toBe(1);
      expect(BigInt(total.s) <= BigInt(CASH_CAP_RUPEES) * 100n).toBe(true);
      await shot(a, 'cash-cap-a');
      await shot(b, 'cash-cap-b');
    });

    await test.step('exact retry of a submitted request replays it; a changed retry with the same request id is refused', async () => {
      await openDeal(a, ids.d2, deal2.ref, 'receipts');
      const input: ReceiptInput = { mode: 'bank_transfer', amount: '1234', payerName: 'Synthetic Retry Payer', pan: 'SYNRT0001R', reference: `SYNRETRY${tag}` };
      let form = await fillReceipt(a, input);
      const requestId = await form.locator('input[name="requestId"]').inputValue();
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      await form.getByRole('button', { name: submitLabel('bank_transfer') }).click();
      await expect(doneIn(form)).toContainText('recorded (internal number)', { timeout: 30_000 });
      const first = /Receipt (R-\d{4}-\d{2}-\d{6,})/.exec((await doneIn(form).textContent()) ?? '')?.[1];
      expect(first).toBeTruthy();

      // The same submission again (for example after a lost response): the page
      // is given the original request id, exactly as an unconfirmed retry keeps it.
      form = await fillReceipt(a, input);
      await form.locator('input[name="requestId"]').evaluate((el, id) => ((el as HTMLInputElement).value = id), requestId);
      await form.getByRole('button', { name: submitLabel('bank_transfer') }).click();
      await expect(doneIn(form)).toContainText(`Receipt ${first} recorded`, { timeout: 30_000 });
      await expect(doneIn(form)).toContainText('(already recorded; nothing changed)');

      form = await fillReceipt(a, { ...input, amount: '1235' });
      await form.locator('input[name="requestId"]').evaluate((el, id) => ((el as HTMLInputElement).value = id), requestId);
      await form.getByRole('button', { name: submitLabel('bank_transfer') }).click();
      await expect(refusedIn(form)).toContainText('This form was already submitted with different details.', { timeout: 30_000 });
      // A refusal keeps what was typed.
      await expect(form.getByLabel('Amount received (₹)')).toHaveValue('1235');

      const rows = await db(async (client) =>
        (await client.query<{ receipt_no: string; amount_paise: string }>(
          'select receipt_no, amount_paise::text from public.customer_receipts where legal_entity_id = $1 and request_id = $2',
          [ENTITY_ID, requestId],
        )).rows,
      );
      expect(rows).toEqual([{ receipt_no: first, amount_paise: '123400' }]);
      await shot(a, 'retry-replayed-and-conflict-refused');
    });

    await test.step('A retires the bank account: the earlier receipt keeps its snapshot; a new bank transfer cannot select it', async () => {
      await a.goto('/app/accounts/destinations');
      const card = destinationCard(a, DEST.bank.label);
      await openSummary(card, 'Retire this account');
      const form = a.getByRole('form', { name: `Retire ${DEST.bank.label}` });
      await form.getByLabel('Reason').fill('Synthetic journey: account closed by the bank');
      await form.getByRole('button', { name: 'Retire account' }).click();
      await expect(destinationCard(a, DEST.bank.label)).toContainText('Retired', { timeout: 30_000 });
      await openDeal(a, ids.d1, deal1.ref, 'receipts');
      await expect(receiptCard(a, bankNo)).toContainText(`${DEST.bank.label} · Bank account · Synthetic Bank ${DEST.bank.masked} · version 1`);
      await openDeal(a, ids.d2, deal2.ref, 'receipts');
      const receiptForm = a.getByRole('form', { name: 'Record a receipt' });
      await receiptForm.getByRole('radio', { name: /^Bank transfer\b/ }).check();
      // This run's retired bank account is never offered (other approved accounts may exist on a reused stack).
      const bankSelect = receiptForm.getByLabel('Company account the money was paid into');
      if (await bankSelect.count()) {
        await expect(bankSelect.locator('option').filter({ hasText: DEST.bank.label })).toHaveCount(0);
      } else {
        await expect(receiptForm).toContainText('No approved company account');
      }
      await receiptForm.getByRole('radio', { name: /^UPI\b/ }).check();
      await expect(receiptForm.getByLabel('Company account the money was paid into')).toBeVisible();
      await shot(a, 'company-account-retired');
    });

    await test.step('no Content Security Policy violation in the Accounts journey', async () => {
      expect(csp.violations).toEqual([]);
    });

    await salesClient.auth.signOut({ scope: 'local' });
    await Promise.all([ctxA.close(), ctxB.close()]);
  });
});
