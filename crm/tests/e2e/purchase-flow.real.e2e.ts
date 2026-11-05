import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { accessTokenOf, challengeViaUi, istToday, rpcAs, signInViaUi, totpCode, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Purchase build (2 Nov 2026), Track E: the real end-to-end browser flow of
 * the Purchase department against a disposable local Supabase stack (Auth,
 * Data API, Postgres, private Storage) served by the production build.
 *
 *   1. SYNTHETIC FIXTURE STEPS: run-tagged synthetic staff (Sales, Purchase,
 *      two Accounts people, a branch Manager), a synthetic Deal whose Sales
 *      owner confirms a hotel booking through the same database commands the
 *      booking screens call, the Accounts booking review approved, two
 *      suppliers (bank details of the final one approved by the Manager) and
 *      one verified customer receipt (recorded by Accounts A, verified by B).
 *   2. Purchase (browser): queue -> Not taken -> Take this task -> Details
 *      (booked facts, no selling price in the page HTML) -> Work: Ask for rates
 *      with Cc -> Mark as sent; two rates, one used as the final rate; Send
 *      booking request -> "Waiting for Accounts go-ahead"; the supplier
 *      confirmation and the payment request are unavailable with a reason.
 *   3. Accounts A: Hotel go-ahead requests -> Give go-ahead.
 *   4. Purchase: deposit request with the supplier's proforma (Accounts
 *      route), confirmation file + reference -> Record supplier confirmation
 *      -> task locked, still locked after a reload.
 *   5. Accounts A approves the payment and its company funding and records
 *      the payment with a proof file; Accounts B verifies; A is refused.
 *   6. Purchase asks for the balance (cumulative above INR 50,000 -> branch
 *      Manager); the Manager approves on Approvals; Purchase cannot approve.
 *   7. No Purchase page or response carries the selling total, the margin,
 *      the receipt amount or the company funding amount (known values).
 *   8. axe (WCAG 2.2 AA tags) and no sideways scroll at 1280 px and 375 px on
 *      the queue, the Work tab, the payment drawer, the Accounts lists and
 *      Approvals; keyboard: drawer opens with Enter, focus stays inside,
 *      Escape closes it, focus returns to the trigger.
 *
 * Synthetic data only, loopback hosts only. Skips without a real stack;
 * fails (never skips) when REQUIRE_REAL_STACK=1 and anything is missing.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(databaseUrl && supabaseUrl && publishableKey && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL, the Supabase URL, publishable key or secret key is missing: the Purchase flow must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Purchase flow runs only against a loopback Supabase stack and database.');
}

const shotDir = process.env.PURCHASE_FLOW_SHOTS ?? 'test-results/real-journey/purchase-flow';
const fileDir = 'test-results/real-journey/purchase-flow-files';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
/** A fresh synthetic password per run (test value generated here; never printed). */
const PASSWORD = `E2e-${randomUUID()}-Pw1`;

const USERS = {
  sales: { id: 'a0000000-0000-4000-8000-0000000005e1', email: 'e2e.pflow.sales@example.test', name: 'E2E Flow Sales', role: 'sales', branch: 'DEL' },
  purchase: { id: 'a0000000-0000-4000-8000-0000000005e2', email: 'e2e.pflow.purchase@example.test', name: 'E2E Flow Purchase', role: 'purchase', branch: 'JDH' },
  accA: { id: 'a0000000-0000-4000-8000-0000000005e3', email: 'e2e.pflow.accounts.a@example.test', name: 'E2E Flow Accounts A', role: 'accounts', branch: 'JDH' },
  accB: { id: 'a0000000-0000-4000-8000-0000000005e4', email: 'e2e.pflow.accounts.b@example.test', name: 'E2E Flow Accounts B', role: 'accounts', branch: 'DEL' },
  manager: { id: 'a0000000-0000-4000-8000-0000000005e5', email: 'e2e.pflow.manager@example.test', name: 'E2E Flow Manager', role: 'manager', branch: 'DEL' },
} as const;
type UserKey = keyof typeof USERS;

// Known synthetic money values (paise). Purchase must never see the first four.
const SELLING_PAISE = '45678901'; // ₹4,56,789.01
const RECEIPT_PAISE = '777777'; // ₹7,777.77 verified customer money
const BUDGET_PAISE = '10000000'; // ₹1,00,000 hotel budget
const RATE_A = 72000;
const RATE_B = 68000; // final rate
const DEPOSIT = 30000; // Accounts route; company funding = 30,000 − 7,777.77 = 22,222.23
const BALANCE = 38000; // cumulative 68,000 > 50,000 -> branch Manager
const FUNDING_PAISE = String(DEPOSIT * 100 - Number(RECEIPT_PAISE)); // 2222223
const MARGIN_PAISE = String(Number(SELLING_PAISE) - RATE_B * 100); // 38878901

const HOTEL_NAME = 'E2E Flow Palace';
const HOTEL = {
  hotelName: HOTEL_NAME,
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-13',
  rooms: 2,
  adults: 3,
  roomType: 'Synthetic Deluxe',
  mealPlan: 'Breakfast',
  children: 1,
  inclusions: null,
  specialRequests: 'Synthetic: late check-in',
};
const TRAVELLERS = [
  { fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 },
  { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 },
  { fullName: 'Synthetic Traveller Three', type: 'adult', seq: 3 },
  { fullName: 'Synthetic Traveller Four', type: 'child', seq: 4, ageYears: 9 },
];

/** Rupee figure as the screens print it and in plain digits, and the paise digits, never next to other digits. */
function moneyPatterns(paise: string): RegExp[] {
  const rupees = (Number(paise) / 100).toFixed(2);
  const [whole, dec] = rupees.split('.') as [string, string];
  const indian = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  const western = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const variants = new Set([`${indian}.${dec}`, `${western}.${dec}`, `${whole}.${dec}`]);
  const out = [...variants].map((v) => new RegExp(`(?<![\\d,])${v.replace(/[.,]/g, (c) => `\\${c}`)}(?![\\d])`));
  out.push(new RegExp(`(?<![0-9a-fA-F])${paise}(?![0-9a-fA-F])`));
  return out;
}
const FORBIDDEN: Array<{ what: string; patterns: RegExp[] }> = [
  { what: 'selling total', patterns: moneyPatterns(SELLING_PAISE) },
  { what: 'margin', patterns: moneyPatterns(MARGIN_PAISE) },
  { what: 'customer receipt amount', patterns: moneyPatterns(RECEIPT_PAISE) },
  { what: 'company funding amount', patterns: moneyPatterns(FUNDING_PAISE) },
  { what: 'customer money signal', patterns: [/customer money has not arrived/i, /ask for company funding/i] },
];

// ---------------------------------------------------------------------------
// Result log (pass/fail per step, written next to the screenshots)
// ---------------------------------------------------------------------------

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function note(step: string, ok: boolean, detail = '') {
  results.push({ step, ok, detail });
}
/** A non-blocking check: recorded, reported as a soft failure, the flow goes on. */
function check(step: string, ok: boolean, detail: string) {
  note(step, ok, detail);
  expect.soft(ok, `${step}: ${detail}`).toBe(true);
}
let shotNo = 0;
async function shot(page: Page, name: string) {
  shotNo += 1;
  await page.screenshot({ path: join(shotDir, `${String(shotNo).padStart(2, '0')}-${name}.png`), fullPage: true });
}

// ---------------------------------------------------------------------------
// Synthetic fixture steps (local stack only)
// ---------------------------------------------------------------------------

const db = <T>(fn: (client: pg.Client) => Promise<T>) => withDb(databaseUrl!, fn);
const admin = () => createClient(supabaseUrl!, secretKey!, { auth: noPersist });

/** Runs one statement as `userId` the way PostgREST does (aal2 claims, role authenticated), committed. */
async function asUser<T = unknown>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  return db(async (client) => {
    await client.query('begin');
    try {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: userId, role: 'authenticated', aal: 'aal2', aud: 'authenticated', iat: now, exp: now + 900,
        amr: [{ method: 'password', timestamp: now - 30 }, { method: 'totp', timestamp: now - 30 }],
      };
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query('set local role authenticated');
      const { rows } = await client.query<{ r: T }>(sql, params);
      await client.query('commit');
      return rows[0]?.r as T;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

/** Uploads real bytes to a private bucket with the local service-role key (as the server does). */
async function putObject(bucket: string, path: string, bytes: Uint8Array<ArrayBuffer>, mime: string) {
  const { error } = await admin().storage.from(bucket).upload(path, new Blob([bytes], { type: mime }), { contentType: mime, upsert: false });
  if (error) throw new Error(`upload to ${bucket} failed: ${error.message}`);
}
const fakePdf = (size = 2048): Uint8Array<ArrayBuffer> => {
  const head = Buffer.from('%PDF-1.4\n% synthetic test file\n');
  const out = new Uint8Array(new ArrayBuffer(size));
  out.fill(32);
  out.set(head, 0);
  return out;
};
const sha = () => randomBytes(32).toString('hex');

/** Synthetic staff with fixed ids: Auth user (fresh password), profile, membership, a fresh TOTP factor. */
async function prepareUsers(): Promise<Record<UserKey, string>> {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the Purchase flow needs the 'test' deployment environment").toBe('test');
  });
  const a = admin();
  for (const u of Object.values(USERS)) {
    const created = await a.auth.admin.createUser({ id: u.id, email: u.email, password: PASSWORD, email_confirm: true });
    if (created.error) {
      if (!/already/i.test(created.error.message)) throw new Error(`could not create ${u.email}: ${created.error.message}`);
      const updated = await a.auth.admin.updateUserById(u.id, { password: PASSWORD });
      if (updated.error) throw new Error(`could not reset ${u.email}: ${updated.error.message}`);
    }
  }
  await db(async (client) => {
    for (const u of Object.values(USERS)) {
      await client.query(
        `insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
         values ($1, $2, $3, 'active', now()) on conflict (user_id) do nothing`,
        [u.id, u.name, u.email],
      );
      await client.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = $3
           and not exists (select 1 from public.memberships m where m.user_id = $1 and m.branch_id = b.id and m.role_code = $2)`,
        [u.id, u.role, u.branch],
      );
    }
    // TOTP secrets from earlier runs are unknown: every flow user enrols afresh.
    await client.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [Object.values(USERS).map((u) => u.id)]);
  });
  const secrets = {} as Record<UserKey, string>;
  for (const [key, u] of Object.entries(USERS) as Array<[UserKey, (typeof USERS)[UserKey]]>) {
    const c = createClient(supabaseUrl!, publishableKey!, { auth: noPersist });
    const signed = await c.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    if (signed.error) throw new Error(`${key} sign-in failed (${signed.error.status ?? 'no status'})`);
    const enrolled = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: `pflow-${key}-${Date.now()}` });
    if (enrolled.error) throw new Error(`${key} TOTP enrolment failed`);
    const verified = await c.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: await totpCode(enrolled.data.totp.secret) });
    if (verified.error) throw new Error(`${key} TOTP verification failed`);
    secrets[key] = enrolled.data.totp.secret;
    await c.auth.signOut({ scope: 'local' });
  }
  return secrets;
}

interface Seeded {
  dealId: string;
  dealRef: string;
  versionId: string;
  taskId: string;
  supplierA: { id: string; name: string; email: string };
  supplierB: { id: string; name: string; email: string };
}

/**
 * SYNTHETIC FIXTURE STEP: the Sales owner confirms a hotel booking (service
 * items) through the same database commands the booking screens call. The
 * service-items switch is turned on only for these commands on this
 * disposable stack and restored right after.
 */
async function seedConfirmedHotel(stamp: number): Promise<Omit<Seeded, 'supplierA' | 'supplierB'>> {
  const S = USERS.sales.id;
  const dealRef = `PF-${stamp}`;
  const dealId = await db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
       select b.legal_entity_id, b.id, $1, 'E2E Purchase flow deal (synthetic)', $2, true
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
      [dealRef, S],
    );
    return rows[0]!.id;
  });
  const before = await db(async (c) => (await c.query<{ on: boolean }>('select service_items_enabled as on from public.workflow_settings where id')).rows[0]!.on);
  await db((c) => c.query('update public.workflow_settings set service_items_enabled = true where id'));
  try {
    const opened = await asUser<{ versionId: string; rowVersion: number }>(S, 'select public.booking_open_draft($1) as r', [dealId]);
    let rv = opened.rowVersion;
    const v = opened.versionId;
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
      [v, rv, 'hotel', JSON.stringify(HOTEL), BUDGET_PAISE, randomUUID()])).rowVersion;
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [dealId, rv, JSON.stringify(TRAVELLERS)])).rowVersion;
    const nullFacts = { hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null, inclusions: null, specialRequests: null, purchaseBudgetPaise: null };
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [v, rv, JSON.stringify(nullFacts), SELLING_PAISE])).rowVersion;
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
      [v, rv, JSON.stringify({ destination: 'Synthetic City, Rajasthan', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' })])).rowVersion;
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [
      v, rv,
      JSON.stringify({ contactName: 'Synthetic Contact', mobile: '9876500011', email: 'contact@example.test', contactConfirmed: true, bookingFor: 'individual', payerDifferent: false, payerName: null }),
      JSON.stringify({ billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }),
      0, randomUUID(),
    ])).rowVersion;
    const items = await db(async (c) => (await c.query<{ id: string }>(
      `select i.id from public.service_items i join public.service_item_facts f on f.service_item_id = i.id where f.booking_version_id = $1`, [v])).rows);
    for (const item of items) {
      rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r', [item.id, v, rv, [1, 2, 3, 4]])).rowVersion;
    }
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
      [v, rv, JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: SELLING_PAISE, dueDate: '2026-11-01' }])])).rowVersion;
    for (const seq of [1, 2, 3, 4]) {
      const bytes = fakePdf();
      const begun = await asUser<{ fileId: string; objectPath: string }>(S, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
        [dealId, seq, randomUUID(), `id-proof-${seq}.pdf`, 'application/pdf', bytes.byteLength, sha()]);
      await putObject('traveller-id-proofs', begun.objectPath, bytes, 'application/pdf');
      await asUser(S, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
    }
    const proof = fakePdf();
    const ev = await asUser<{ evidenceId: string; objectPath: string }>(S, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
      [v, 'acceptance_message', 'acceptance.pdf', 'application/pdf', proof.byteLength, sha()]);
    await putObject('booking-evidence', ev.objectPath, proof, 'application/pdf');
    await asUser(S, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
    const ready = await asUser<{ issues: string[]; contentHash: string }>(S, 'select public.booking_readiness($1) as r', [v]);
    expect(ready.issues, 'synthetic booking is ready to confirm').toEqual([]);
    await asUser(S, 'select public.booking_confirm($1, $2) as r', [v, ready.contentHash]);
    const taskId = await db(async (c) => (await c.query<{ id: string }>(
      `select id from public.fulfilment_tasks where deal_id = $1 and department = 'purchase' and service_purpose = 'hotel'`, [dealId])).rows[0]!.id);
    return { dealId, dealRef, versionId: v, taskId };
  } finally {
    await db((c) => c.query('update public.workflow_settings set service_items_enabled = $1 where id', [before]));
  }
}

/** SYNTHETIC FIXTURE STEP (no Accounts review screen in scope): the booking review of this version is approved by Accounts A. */
async function approveBookingReview(versionId: string) {
  await db((c) => c.query(
    `insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
     select v.id, v.deal_id, v.legal_entity_id, 'approved', $2, now() from public.booking_versions v where v.id = $1
     on conflict (booking_version_id) do update set status = 'approved', row_version = public.accounts_booking_reviews.row_version + 1,
       reviewed_by = excluded.reviewed_by, reviewed_at = now(), updated_at = now()`,
    [versionId, USERS.accA.id],
  ));
}

/** SYNTHETIC FIXTURE STEP: two hotel suppliers created by Purchase; the final one's bank details approved by the Manager. */
async function seedSuppliers(stamp: number) {
  const entityId = await db(async (c) => (await c.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`)).rows[0]!.id);
  const make = async (tag: string) => {
    const name = `E2E Stays ${tag} ${stamp}`;
    const email = `desk.${tag.toLowerCase()}.${stamp}@example.test`;
    const { supplierId } = await asUser<{ supplierId: string }>(USERS.purchase.id, 'select public.supplier_create($1, $2::jsonb) as r', [
      entityId,
      JSON.stringify({ name, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: 'Synthetic Desk', contactPhone: '+91 00000 00000', contactEmail: email, paymentTerms: 'Synthetic: 50% at confirmation' }),
    ]);
    return { id: supplierId, name, email };
  };
  const supplierA = await make('A');
  const supplierB = await make('B');
  const rev = await asUser<{ revisionNo: number }>(USERS.purchase.id, 'select public.supplier_add_beneficiary($1, $2, $3::jsonb) as r', [
    supplierB.id, randomUUID(), JSON.stringify({ accountHolder: 'Synthetic Stays B Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000011112222' })]);
  await asUser(USERS.manager.id, 'select public.supplier_approve_beneficiary($1, $2) as r', [supplierB.id, rev.revisionNo]);
  return { supplierA, supplierB };
}

/** SYNTHETIC FIXTURE STEP: one verified bank receipt on the Deal (Accounts A records, B verifies). */
async function seedVerifiedReceipt(dealId: string, stamp: number) {
  const ver = await db(async (c) => {
    const { rows: [dest] } = await c.query<{ id: string; legal_entity_id: string }>(
      `insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
       select d.legal_entity_id, 'bank', $3, d.is_synthetic, $2 from public.deals d where d.id = $1 returning id, legal_entity_id`,
      [dealId, USERS.accA.id, `E2E flow destination ${stamp}`]);
    const { rows: [v] } = await c.query<{ id: string }>(
      `insert into public.company_destination_versions (legal_entity_id, destination_id, version_no, holder_name, bank_name,
         account_number, ifsc, status, maker, request_id, decided_by, decided_at)
       values ($1, $2, 1, 'Synthetic Holder', 'Synthetic Bank', '000123456789', 'SYNB0000001', 'approved', $3, gen_random_uuid(), $4, now()) returning id`,
      [dest!.legal_entity_id, dest!.id, USERS.accA.id, USERS.accB.id]);
    await c.query('update public.company_destinations set current_version_id = $1 where id = $2', [v!.id, dest!.id]);
    return v!.id;
  });
  const del = await db(async (c) => (await c.query<{ id: string }>(
    `select b.id from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`)).rows[0]!.id);
  const rec = await asUser<{ id: string }>(USERS.accA.id, 'select public.receipt_record($1, $2::jsonb, $3) as r', [dealId, JSON.stringify({
    mode: 'bank_transfer', amountPaise: RECEIPT_PAISE, receivedOn: istToday(), branchId: del, payerName: 'Synthetic Payer',
    payerPan: 'ABCDE1234F', reference: `UTRPF${stamp}`, destinationVersionId: ver,
  }), randomUUID()]);
  const bytes = fakePdf();
  const proof = await asUser<{ id: string; objectPath: string }>(USERS.accA.id, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
    ['receipt', rec.id, 'bank_proof', 'proof.pdf', 'application/pdf', bytes.byteLength, sha(), randomUUID()]);
  await putObject('finance-evidence', proof.objectPath, bytes, 'application/pdf');
  await asUser(USERS.accA.id, 'select public.finance_evidence_finish($1, true) as r', [proof.id]);
  await asUser(USERS.accB.id, 'select public.receipt_verify($1, $2) as r', [rec.id, randomUUID()]);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

interface Session {
  context: BrowserContext;
  page: Page;
}

async function signIn(browser: Browser, key: UserKey, secret: string): Promise<Session> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await signInViaUi(page, USERS[key].email, PASSWORD);
  await challengeViaUi(page, secret);
  await expect(page).toHaveURL(/\/app(\/|$|\?)/);
  return { context, page };
}

/**
 * How long one response body may take to read. A body the browser can no
 * longer give (the page navigated away, as after "Mark as sent" and a reload)
 * either rejects or, for some server action responses, never settles at all:
 * without a bound, step 7 waited on it until the test timed out (CI, 2 Nov
 * 2026). Such a body counts as unreadable, exactly like a rejected read.
 */
const BODY_READ_MS = 10_000;

/** Every same-origin response body the Purchase browser receives (HTML, RSC payloads, server action results). */
function recordResponses(page: Page, into: Array<Promise<{ url: string; body: string; readable: boolean }>>) {
  page.on('response', (res) => {
    const url = res.url();
    if (!url.startsWith('http://127.0.0.1') || /\/_next\/static\//.test(url)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unreadable = new Promise<{ url: string; body: string; readable: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ url, body: '', readable: false }), BODY_READ_MS);
    });
    const read = res.text().then((body) => ({ url, body, readable: true })).catch(() => ({ url, body: '', readable: false }));
    into.push(Promise.race([read, unreadable]).finally(() => clearTimeout(timer)));
  });
}

function leaksIn(text: string): string[] {
  const found: string[] = [];
  for (const f of FORBIDDEN) for (const p of f.patterns) if (p.test(text)) found.push(`${f.what} (${p.source})`);
  return found;
}

async function noLeakOnPage(page: Page, label: string) {
  const html = await page.content();
  const found = leaksIn(html);
  check(`7 · no money leak · ${label}`, found.length === 0, found.length ? `page HTML contains ${found.join(', ')}` : 'clean');
}

async function noSidewaysScroll(page: Page, label: string) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`8 · no sideways scroll · ${label}`, sw <= cw + 1, `scrollWidth ${sw} vs clientWidth ${cw}`);
}

async function axe(page: Page, label: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (include) builder = builder.include(include);
  const r = await builder.analyze();
  const v = r.violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  check(`8 · axe · ${label}`, v.length === 0, v.length ? v.join('; ') : 'no violations');
}

/** axe + overflow at 1280 px and 375 px, then back to 1280 px. `reopen` re-opens a drawer after the resize when needed. */
async function a11yBothWidths(page: Page, label: string, opts: { include?: string; shotName?: string } = {}) {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 860 });
    await page.waitForTimeout(300);
    await axe(page, `${label} @${width}`, opts.include);
    await noSidewaysScroll(page, `${label} @${width}`);
    if (opts.shotName) await shot(page, `${opts.shotName}-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}

/** Keyboard: Enter opens the drawer, Tab/Shift+Tab stay inside, Escape closes, focus returns to the trigger. */
async function drawerKeyboard(page: Page, trigger: Locator, label: string) {
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  const opened = await dialog.isVisible({ timeout: 5_000 }).catch(() => false) || (await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false));
  check(`8 · keyboard · ${label} opens with Enter`, opened, opened ? 'dialog visible' : 'no dialog after Enter');
  if (!opened) return;
  const inside = () => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('[role="dialog"]'));
  let escaped = 0;
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    if (!(await inside())) escaped += 1;
  }
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Shift+Tab');
    if (!(await inside())) escaped += 1;
  }
  check(`8 · keyboard · ${label} focus trapped`, escaped === 0, `${escaped} of 38 Tab presses left the dialog`);
  await page.keyboard.press('Escape');
  const closed = await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).then(() => true).catch(() => false);
  check(`8 · keyboard · ${label} Escape closes`, closed, closed ? 'closed' : 'dialog still open');
  const back = await trigger.evaluate((el) => el === document.activeElement).catch(() => false);
  check(`8 · keyboard · ${label} focus returns to trigger`, back, back ? 'trigger focused' : 'focus elsewhere');
}

const workUrl = (taskId: string) => `/app/purchase/${taskId}?tab=work`;

async function stepRun(name: string, fn: () => Promise<void>) {
  await test.step(name, async () => {
    try {
      await fn();
      note(name, true, 'passed');
    } catch (error) {
      note(name, false, (error as Error).message.replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join(' ').slice(0, 600));
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

test.describe('Purchase department: real end-to-end flow (Purchase build)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (TEST_DATABASE_URL, Supabase URL and keys).');

  test('queue to verified supplier payment, with money privacy, accessibility and keyboard checks', async ({ browser }) => {
    test.setTimeout(1_200_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(fileDir, { recursive: true });
    const stamp = Date.now();
    const pdf = (name: string) => {
      const p = join(fileDir, `${name}-${stamp}.pdf`);
      writeFileSync(p, fakePdf(4096));
      return p;
    };
    const purchaseResponses: Array<Promise<{ url: string; body: string; readable: boolean }>> = [];
    let seeded!: Seeded;
    let secrets!: Record<UserKey, string>;
    let P!: Session;
    let A!: Session;
    let B!: Session;
    let M!: Session;
    const contexts: BrowserContext[] = [];

    try {
      await stepRun('1 · fixture: staff, confirmed hotel booking, review approved, suppliers, verified receipt', async () => {
        secrets = await prepareUsers();
        const booked = await seedConfirmedHotel(stamp);
        await approveBookingReview(booked.versionId);
        const sup = await seedSuppliers(stamp);
        await seedVerifiedReceipt(booked.dealId, stamp);
        seeded = { ...booked, ...sup };
        const t = await db(async (c) => (await c.query<{ status: string; assignee: string | null }>(
          'select status, assignee_user_id as assignee from public.fulfilment_tasks where id = $1', [seeded.taskId])).rows[0]!);
        expect(t, 'hotel task created, not taken').toEqual({ status: 'not_started', assignee: null });
      });

      await stepRun('2a · Purchase: queue shows the task under Not taken; Take this task', async () => {
        P = await signIn(browser, 'purchase', secrets.purchase);
        contexts.push(P.context);
        recordResponses(P.page, purchaseResponses);
        const page = P.page;
        await page.goto('/app/purchase');
        await expect(page.getByRole('heading', { level: 1, name: 'Purchase tasks' })).toBeVisible();
        const notTaken = page.getByRole('link', { name: /Not taken/ }).first();
        await expect(notTaken).toHaveAttribute('aria-current', /page|true/);
        const row = page.getByRole('row').filter({ hasText: seeded.dealRef });
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(HOTEL_NAME);
        await expect(row).toContainText('Not taken');
        await shot(page, 'purchase-queue-not-taken');
        await noLeakOnPage(page, 'queue');
        await a11yBothWidths(page, 'Purchase queue', { shotName: 'purchase-queue' });
        await row.getByRole('link', { name: new RegExp(HOTEL_NAME) }).click();
        await expect(page).toHaveURL(new RegExp(`/app/purchase/${seeded.taskId}`));
        await page.getByRole('button', { name: 'Take this task' }).click();
        await expect(page.getByText(/The task is yours|Taken by: you/i).first()).toBeVisible();
        await page.reload();
        await expect(page.getByText(/Taken by: you/i)).toBeVisible();
      });

      await stepRun('2b · Purchase: Details shows booked facts, no selling price in the HTML', async () => {
        const page = P.page;
        await page.goto(`/app/purchase/${seeded.taskId}?tab=details`);
        const main = page.locator('main');
        await expect(main).toContainText(HOTEL_NAME);
        await expect(main).toContainText('Synthetic City');
        await expect(main).toContainText(/Synthetic Deluxe/);
        await expect(main).toContainText(/Breakfast/);
        await expect(main).toContainText(/late check-in/);
        await expect(main).toContainText(seeded.dealRef);
        await shot(page, 'purchase-details');
        const html = await page.content();
        const leaks = leaksIn(html);
        expect(leaks, 'Details page HTML carries no selling/margin/receipt/funding value').toEqual([]);
      });

      await stepRun('2c · Purchase: Ask for rates drawer with Cc -> Mark as sent', async () => {
        const page = P.page;
        await page.goto(workUrl(seeded.taskId));
        const ask = page.getByRole('button', { name: 'Ask for rates' });
        await expect(ask).toBeVisible();
        await drawerKeyboard(page, ask, 'Ask for rates drawer');
        await ask.click();
        const dlg = page.getByRole('dialog', { name: 'Ask the supplier for rates' });
        await expect(dlg).toBeVisible();
        const supplierSelect = dlg.getByLabel('Supplier', { exact: true });
        if (await supplierSelect.count()) await supplierSelect.selectOption({ label: seeded.supplierA.name });
        await expect(dlg.getByLabel('To', { exact: true })).toHaveValue(seeded.supplierA.email);
        await dlg.getByLabel('Cc (optional)', { exact: true }).fill('e2e.cc.one@example.test, e2e.cc.two@example.test');
        await expect(dlg.getByLabel('Subject', { exact: true })).toHaveValue(new RegExp(`Rate request · ${seeded.dealRef}`));
        await expect(dlg.getByRole('button', { name: 'Copy draft' })).toBeVisible();
        await expect(dlg.getByRole('link', { name: 'Open in e-mail app' })).toHaveAttribute('href', /^mailto:/);
        await shot(page, 'purchase-ask-for-rates-drawer');
        await dlg.getByRole('button', { name: 'Mark as sent' }).click();
        await expect(dlg.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
        await dlg.getByRole('button', { name: 'Close', exact: true }).click();
        const email = await db(async (c) => (await c.query<{ kind: string; status: string; cc: string[]; to_email: string; subject: string; body: string }>(
          `select kind, status, cc_emails as cc, to_email, subject, body from public.purchase_supplier_emails where task_id = $1 order by sent_at`, [seeded.taskId])).rows);
        expect(email).toHaveLength(1);
        expect(email[0]).toMatchObject({ kind: 'rate_request', status: 'marked_sent', to_email: seeded.supplierA.email, cc: ['e2e.cc.one@example.test', 'e2e.cc.two@example.test'] });
        expect(leaksIn(`${email[0]!.subject}\n${email[0]!.body}`), 'rate request e-mail carries no selling value').toEqual([]);
      });

      await stepRun('2d · Purchase: two rates added, one used as the final rate', async () => {
        const page = P.page;
        await page.goto(workUrl(seeded.taskId));
        const form = page.getByRole('form', { name: 'Add a rate' });
        for (const [s, amount] of [[seeded.supplierA, RATE_A], [seeded.supplierB, RATE_B]] as const) {
          await form.getByLabel('Supplier', { exact: true }).selectOption({ label: s.name });
          await form.getByLabel('Amount for the whole stay (₹)', { exact: true }).fill(String(amount));
          await form.getByLabel('Note (optional)', { exact: true }).fill(`Synthetic rate from ${s.name}`);
          await form.getByRole('button', { name: 'Add rate' }).click();
          await expect(page.getByRole('list', { name: 'Rates from suppliers' }).getByRole('listitem', { name: s.name })).toBeVisible();
        }
        const tiles = page.getByRole('list', { name: 'Rates from suppliers' }).getByRole('listitem');
        await expect(tiles).toHaveCount(2);
        await page.getByRole('listitem', { name: seeded.supplierB.name }).getByRole('button', { name: 'Use as final rate' }).click();
        const finalTile = page.getByRole('listitem', { name: `${seeded.supplierB.name}, final rate` });
        await expect(finalTile).toBeVisible();
        await expect(finalTile).toContainText('68,000');
        await shot(page, 'purchase-work-final-rate');
        await noLeakOnPage(page, 'Work tab with final rate');
        await a11yBothWidths(page, 'Purchase task Work tab', { shotName: 'purchase-work' });
      });

      await stepRun('2e · Purchase: Send booking request -> Waiting for Accounts go-ahead; confirmation and payment unavailable', async () => {
        const page = P.page;
        await page.goto(workUrl(seeded.taskId));
        const finalTile = page.getByRole('listitem', { name: `${seeded.supplierB.name}, final rate` });
        await finalTile.getByRole('button', { name: 'Send booking request' }).click();
        const dlg = page.getByRole('dialog', { name: 'Send the booking request' });
        await expect(dlg).toBeVisible();
        await expect(dlg.getByLabel('To', { exact: true })).toHaveValue(seeded.supplierB.email);
        await expect(dlg.getByLabel('Subject', { exact: true })).toHaveValue(new RegExp(`Booking request · ${seeded.dealRef}`));
        await dlg.getByLabel('Cc (optional)', { exact: true }).fill('e2e.cc.one@example.test');
        await dlg.getByRole('button', { name: 'Mark as sent' }).click();
        // The success line may sit in the drawer or, after the tile re-renders, at page level.
        await expect(page.getByText(/Booking request recorded/).first()).toBeVisible({ timeout: 30_000 });
        const closeBtn = dlg.getByRole('button', { name: 'Close', exact: true });
        if (await closeBtn.isVisible()) await closeBtn.click();
        await page.reload();
        await expect(page.getByText('Waiting for Accounts go-ahead').first()).toBeVisible();
        const confirm = page.getByRole('button', { name: 'Record supplier confirmation' });
        await expect(confirm).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByText('Waiting for Accounts go-ahead. Accounts approves every hotel commitment.').first()).toBeVisible();
        const pay = page.getByRole('button', { name: /Request (advance )?payment/ });
        await expect(pay).toHaveAttribute('aria-disabled', 'true');
        const payReason = await pay.evaluate((el) => {
          const id = el.getAttribute('aria-describedby');
          return id ? (document.getElementById(id)?.textContent ?? '') : '';
        });
        expect(payReason, 'payment request shows a reason').toMatch(/\S/);
        note('2e · payment request unavailable reason', true, payReason);
        await shot(page, 'purchase-waiting-go-ahead');
        const rows = await db(async (c) => (await c.query<{ status: string; amount: string }>(
          `select status, amount_paise::text as amount from public.purchase_go_ahead_requests where task_id = $1`, [seeded.taskId])).rows);
        expect(rows).toEqual([{ status: 'pending', amount: String(RATE_B * 100) }]);
        // The e-mail result is recorded by the server only: Purchase cannot call it through the Data API.
        const emailId = await db(async (c) => (await c.query<{ id: string }>(
          `select id from public.purchase_supplier_emails where task_id = $1 and kind = 'booking_request'`, [seeded.taskId])).rows[0]!.id);
        const mark = await rpcAs(supabaseUrl!, publishableKey!, await accessTokenOf(P.context), 'purchase_email_mark_result', { p_email_id: emailId, p_status: 'sent', p_provider_id: 'x', p_failure: null });
        check('2e · e-mail result is server-only', mark.status >= 400, `Data API status ${mark.status} ${mark.body?.message ?? ''}`);
      });

      await stepRun('3 · Accounts A: Hotel go-ahead requests shows the request; Give go-ahead', async () => {
        A = await signIn(browser, 'accA', secrets.accA);
        contexts.push(A.context);
        const page = A.page;
        await page.goto('/app/accounts/go-ahead');
        await expect(page.getByRole('heading', { level: 1, name: 'Hotel go-ahead requests' })).toBeVisible();
        const item = page.locator('article').filter({ hasText: seeded.dealRef });
        await expect(item).toHaveCount(1);
        await expect(item).toContainText('Booking review approved');
        await expect(item).toContainText('68,000');
        await a11yBothWidths(page, 'Accounts go-ahead list', { shotName: 'accounts-go-ahead' });
        await item.getByRole('button', { name: 'Give go-ahead' }).click();
        await expect(page.locator('article').filter({ hasText: seeded.dealRef })).toHaveCount(0, { timeout: 15_000 }).catch(async () => {
          await page.reload();
        });
        await page.goto('/app/accounts/go-ahead?tab=all');
        await expect(page.locator('article').filter({ hasText: seeded.dealRef })).toContainText('Go-ahead given');
        const st = await db(async (c) => (await c.query<{ status: string }>(`select status from public.purchase_go_ahead_requests where task_id = $1`, [seeded.taskId])).rows);
        expect(st).toEqual([{ status: 'approved' }]);
      });

      let depositRef = '';
      await stepRun('4a · Purchase: deposit request with proforma routes to Accounts (≤ ₹50,000)', async () => {
        const page = P.page;
        await page.goto(workUrl(seeded.taskId));
        const trigger = page.getByRole('button', { name: 'Request advance payment' });
        await expect(trigger).toBeVisible();
        await expect(trigger).not.toHaveAttribute('aria-disabled', 'true');
        await drawerKeyboard(page, trigger, 'Payment request drawer');
        await trigger.click();
        const dlg = page.getByRole('dialog', { name: 'Request a supplier payment' });
        await expect(dlg).toBeVisible();
        await a11yBothWidths(page, 'Payment request drawer', { include: '[role="dialog"]', shotName: 'purchase-payment-drawer' });
        if (!(await dlg.isVisible())) {
          await trigger.click();
          await expect(dlg).toBeVisible();
        }
        await expect(dlg.getByLabel('Part', { exact: true })).toHaveValue('deposit');
        await dlg.getByLabel('Amount (₹)', { exact: true }).fill(String(DEPOSIT));
        await expect(dlg.getByText('Accounts approves', { exact: true })).toBeVisible();
        await dlg.getByLabel('Supplier proforma or hold document', { exact: true }).setInputFiles(pdf('proforma'));
        await dlg.getByRole('button', { name: 'Send payment request' }).click();
        await expect(dlg.getByRole('button', { name: 'Close', exact: true })).toBeVisible({ timeout: 30_000 });
        await shot(page, 'purchase-deposit-sent');
        await noLeakOnPage(page, 'payment drawer after send');
        await dlg.getByRole('button', { name: 'Close', exact: true }).click();
        const rows = await db(async (c) => (await c.query<{ ref: string; route: string; status: string; part: string }>(
          `select ref_no as ref, route, status, part from public.supplier_payment_requests where task_id = $1`, [seeded.taskId])).rows);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ route: 'accounts', status: 'pending', part: 'deposit' });
        depositRef = rows[0]!.ref;
        const funding = await db(async (c) => (await c.query<{ amount: string; route: string }>(
          `select amount_paise::text as amount, route from public.company_funding_requests where deal_id = $1`, [seeded.dealId])).rows);
        expect(funding, 'server created company funding for the uncovered part').toEqual([{ amount: FUNDING_PAISE, route: 'accounts' }]);
        await page.reload();
        await expect(page.getByRole('list', { name: 'Payment requests on this service' })).toContainText('Waiting for Accounts');
        await noLeakOnPage(page, 'Work tab with payment request');
      });

      await stepRun('4b · Purchase: confirmation file + reference -> Record supplier confirmation -> locked; reload persists', async () => {
        const page = P.page;
        await page.goto(workUrl(seeded.taskId));
        const up = page.getByRole('form', { name: 'Upload a Purchase file' });
        await up.getByLabel('What is this file?', { exact: true }).selectOption('supplier_confirmation');
        await up.getByLabel('File', { exact: true }).setInputFiles(pdf('supplier-confirmation'));
        await up.getByRole('button', { name: 'Upload file' }).click();
        await expect(page.getByRole('list', { name: 'Purchase files' })).toContainText('Stored', { timeout: 30_000 });
        await page.reload();
        await page.getByRole('button', { name: 'Record supplier confirmation' }).click();
        const dlg = page.getByRole('dialog');
        await dlg.getByLabel('Supplier confirmation reference', { exact: true }).fill(`CNF-${stamp}`);
        await dlg.getByRole('button', { name: 'Record supplier confirmation' }).click();
        await expect(page.getByText(`Confirmed · reference CNF-${stamp}`)).toBeVisible({ timeout: 30_000 });
        await page.reload();
        await expect(page.getByText(`Confirmed · reference CNF-${stamp}`)).toBeVisible();
        await expect(page.getByText('Confirmed by supplier').first()).toBeVisible();
        await expect(page.getByRole('form', { name: 'Add a rate' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Use as final rate' })).toHaveCount(0);
        await expect(page.getByRole('form', { name: 'Upload a Purchase file' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Send booking request again' })).toHaveCount(0);
        await shot(page, 'purchase-confirmed-locked');
        const t = await db(async (c) => (await c.query<{ status: string; ref: string }>(
          'select status, supplier_reference as ref from public.fulfilment_tasks where id = $1', [seeded.taskId])).rows[0]!);
        expect(t).toEqual({ status: 'supplier_confirmed', ref: `CNF-${stamp}` });
      });

      await stepRun('5a · Accounts A: approve payment and its company funding, record payment with proof', async () => {
        const page = A.page;
        await page.goto('/app/accounts/supplier-payments');
        await expect(page.getByRole('heading', { level: 1, name: 'Supplier payments' })).toBeVisible();
        const item = page.locator('article').filter({ hasText: depositRef });
        await expect(item).toHaveCount(1);
        await expect(item).toContainText('22,222.23');
        await a11yBothWidths(page, 'Accounts supplier payments · To approve', { shotName: 'accounts-payments-to-approve' });
        await item.getByRole('button', { name: 'Approve payment' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>('select status as s from public.supplier_payment_requests where ref_no = $1', [depositRef])).rows[0]!.s)).toBe('approved');
        await page.goto('/app/accounts/funding');
        const fund = page.locator('article').filter({ hasText: depositRef });
        await expect(fund).toHaveCount(1);
        await a11yBothWidths(page, 'Accounts company funding', { shotName: 'accounts-funding' });
        await fund.getByRole('button', { name: 'Approve company funding' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
          `select f.status as s from public.company_funding_requests f join public.supplier_payment_requests p on p.id = f.payment_request_id where p.ref_no = $1`, [depositRef])).rows[0]!.s)).toBe('approved');
        await page.goto('/app/accounts/supplier-payments?tab=to_record');
        const rec = page.locator('article').filter({ hasText: depositRef });
        await expect(rec).toHaveCount(1);
        await a11yBothWidths(page, 'Accounts supplier payments · To pay and record', { shotName: 'accounts-payments-to-record' });
        await rec.getByText('Record the payment', { exact: true }).click();
        await rec.getByLabel('Paid on', { exact: true }).fill(istToday());
        await rec.getByLabel('Bank reference (UTR)', { exact: true }).fill(`UTRSUP${stamp}`);
        await rec.getByLabel('Payment proof', { exact: true }).setInputFiles(pdf('payment-proof'));
        await rec.getByRole('button', { name: 'Record payment' }).click();
        const statusOf = async () => db(async (c) => (await c.query<{ s: string }>('select status as s from public.supplier_payment_requests where ref_no = $1', [depositRef])).rows[0]!.s);
        await expect.poll(statusOf, { timeout: 30_000 }).toBe('paid');
        await shot(page, 'accounts-payment-recorded');
      });

      await stepRun('5b · Accounts B verifies; the recorder (A) is refused', async () => {
        await A.page.goto('/app/accounts/supplier-payments?tab=to_verify');
        const inToVerify = await A.page.locator('article').filter({ hasText: depositRef }).count();
        note('5b · recorder\'s own payment in A\'s "To verify" tab', true, inToVerify ? 'listed (verify unavailable)' : 'not listed (only colleagues verify); checked on All');
        if (!inToVerify) await A.page.goto('/app/accounts/supplier-payments?tab=all');
        const own = A.page.locator('article').filter({ hasText: depositRef });
        await expect(own).toHaveCount(1);
        await expect(own.getByRole('button', { name: 'Mark payment verified' })).toHaveAttribute('aria-disabled', 'true');
        await expect(own).toContainText('You recorded this payment, so another Accounts person verifies it.');
        await a11yBothWidths(A.page, 'Accounts supplier payments · To verify', { shotName: 'accounts-payments-to-verify' });
        const row = await db(async (c) => (await c.query<{ id: string; rv: number }>('select id, row_version as rv from public.supplier_payment_requests where ref_no = $1', [depositRef])).rows[0]!);
        const self = await rpcAs(supabaseUrl!, publishableKey!, await accessTokenOf(A.context), 'supplier_payment_verify', { p_payment_id: row.id, p_expected_row_version: row.rv, p_request_id: randomUUID() });
        expect(self.status, 'Data API refuses self-verification').toBeGreaterThanOrEqual(400);
        expect(self.body?.message).toBe('not_self_verification');
        B = await signIn(browser, 'accB', secrets.accB);
        contexts.push(B.context);
        await B.page.goto('/app/accounts/supplier-payments?tab=to_verify');
        const item = B.page.locator('article').filter({ hasText: depositRef });
        await expect(item).toHaveCount(1);
        await item.getByRole('button', { name: 'Mark payment verified' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string; v: string | null }>('select status as s, verified_by::text as v from public.supplier_payment_requests where ref_no = $1', [depositRef])).rows[0]!), { timeout: 30_000 }).toEqual({ s: 'verified', v: USERS.accB.id });
        await shot(B.page, 'accounts-b-verified');
      });

      let balanceRef = '';
      await stepRun('6a · Purchase: balance request above ₹50,000 cumulative routes to the branch Manager', async () => {
        const page = P.page;
        await page.goto(workUrl(seeded.taskId));
        await expect(page.getByRole('list', { name: 'Payment requests on this service' })).toContainText(/Verified/i);
        await shot(page, 'purchase-work-after-confirmation');
        const trigger = page.getByRole('button', { name: /^Request (advance )?payment$/ });
        await expect(trigger).toHaveText('Request payment');
        await expect(trigger).not.toHaveAttribute('aria-disabled', 'true');
        await trigger.click();
        const dlg = page.getByRole('dialog', { name: 'Request a supplier payment' });
        await dlg.getByLabel('Part', { exact: true }).selectOption('balance');
        await dlg.getByLabel('Amount (₹)', { exact: true }).fill(String(BALANCE));
        await expect(dlg.getByText('Branch Manager approves', { exact: true })).toBeVisible();
        await dlg.getByLabel('Supplier proforma or hold document', { exact: true }).setInputFiles(pdf('proforma-balance'));
        await dlg.getByLabel('Note for Accounts (optional)', { exact: true }).fill('Synthetic: supplier needs the balance before check-in.');
        await dlg.getByRole('button', { name: 'Send payment request' }).click();
        // The drawer unmounts when nothing is left to request; the success line is then shown at page level.
        await expect(page.getByText(/Payment request sent to the branch Manager/).first()).toBeVisible({ timeout: 30_000 });
        if (await dlg.getByRole('button', { name: 'Close', exact: true }).isVisible()) await dlg.getByRole('button', { name: 'Close', exact: true }).click();
        const rows = await db(async (c) => (await c.query<{ ref: string; route: string }>(
          `select ref_no as ref, route from public.supplier_payment_requests where task_id = $1 and part = 'balance'`, [seeded.taskId])).rows);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.route).toBe('manager');
        balanceRef = rows[0]!.ref;
        await page.reload();
        await expect(page.getByRole('list', { name: 'Payment requests on this service' })).toContainText('Waiting for the branch Manager');
        await noLeakOnPage(page, 'Work tab after balance request');
        await page.goto('/app/purchase/payments');
        await expect(page.getByText(balanceRef).first()).toBeVisible();
        await shot(page, 'purchase-payments-page');
        await noLeakOnPage(page, 'Purchase payment requests page');
        await a11yBothWidths(page, 'Purchase payment requests page');
      });

      await stepRun('6b · Purchase cannot approve its own request', async () => {
        const row = await db(async (c) => (await c.query<{ id: string; rv: number }>('select id, row_version as rv from public.supplier_payment_requests where ref_no = $1', [balanceRef])).rows[0]!);
        const r = await rpcAs(supabaseUrl!, publishableKey!, await accessTokenOf(P.context), 'supplier_payment_decide', { p_payment_id: row.id, p_decision: 'approve', p_reason: null, p_expected_row_version: row.rv, p_request_id: randomUUID() });
        expect(r.status, 'Data API refuses Purchase approving its own request').toBeGreaterThanOrEqual(400);
        note('6b · refusal token', true, String(r.body?.message));
        await P.page.goto('/app/approvals');
        await expect(P.page.getByRole('button', { name: 'Approve payment' })).toHaveCount(0);
        await shot(P.page, 'purchase-approvals-not-for-you');
      });

      await stepRun('6c · Manager: Approvals shows the > ₹50,000 request; approve payment and company funding', async () => {
        M = await signIn(browser, 'manager', secrets.manager);
        contexts.push(M.context);
        const page = M.page;
        await page.goto('/app/approvals');
        await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
        const pay = page.locator('#ap-payments').locator('article').filter({ hasText: balanceRef });
        const payAny = page.locator('article').filter({ hasText: balanceRef });
        const target = (await pay.count()) > 0 ? pay : payAny;
        await expect(target.first()).toBeVisible();
        await expect(target.first()).toContainText('38,000');
        await a11yBothWidths(page, 'Manager Approvals', { shotName: 'manager-approvals' });
        await target.first().getByRole('button', { name: 'Approve payment' }).click();
        await expect.poll(async () => db(async (c) => (await c.query<{ s: string; by: string }>('select status as s, approved_by::text as by from public.supplier_payment_requests where ref_no = $1', [balanceRef])).rows[0]!), { timeout: 30_000 }).toEqual({ s: 'approved', by: USERS.manager.id });
        await page.reload();
        await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
        const fund = page.locator('article').filter({ hasText: balanceRef }).filter({ has: page.getByRole('button', { name: 'Approve company funding' }) });
        if (await fund.first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false)) {
          await fund.first().getByRole('button', { name: 'Approve company funding' }).click();
          await expect.poll(async () => db(async (c) => (await c.query<{ s: string }>(
            `select f.status as s from public.company_funding_requests f join public.supplier_payment_requests p on p.id = f.payment_request_id where p.ref_no = $1`, [balanceRef])).rows[0]!.s), { timeout: 30_000 }).toBe('approved');
          note('6c · manager funding approve', true, 'company funding above ₹50,000 approved by the Manager');
        } else {
          const route = await db(async (c) => (await c.query<{ route: string }>(
            `select f.route from public.company_funding_requests f join public.supplier_payment_requests p on p.id = f.payment_request_id where p.ref_no = $1`, [balanceRef])).rows[0]?.route);
          check('6c · manager funding item shown', false, `no "Approve company funding" for ${balanceRef} on Approvals (funding route ${route ?? 'none'})`);
        }
        await shot(page, 'manager-approved');
      });

      await stepRun('7 · Purchase responses never carry selling, margin, receipt or funding amounts', async () => {
        // Revisit the Purchase pages once more so every read is captured after all money exists.
        for (const path of ['/app/purchase', '/app/purchase?show=all', `/app/purchase/${seeded.taskId}`, workUrl(seeded.taskId), `/app/purchase/${seeded.taskId}?tab=files`, `/app/purchase/${seeded.taskId}?tab=history`, '/app/purchase/payments', '/app']) {
          await P.page.goto(path);
          await P.page.waitForLoadState('networkidle');
          await noLeakOnPage(P.page, path);
        }
        const bodies = await Promise.all(purchaseResponses);
        const hits = bodies.flatMap((b) => leaksIn(b.body).map((l) => `${new URL(b.url).pathname}${new URL(b.url).search}: ${l}`));
        const read = bodies.filter((b) => b.readable).length;
        // A check over bodies nobody could read proves nothing: require a real sample (about 65 of
        // ~400 are readable in a full run; the rest navigated away first).
        check('7 · no money leak · network responses', hits.length === 0 && read >= 20, read < 20 ? `only ${read} responses were readable` : hits.length ? [...new Set(hits)].slice(0, 10).join('; ') : `${read} readable responses clean (${bodies.length - read} navigated away before they could be read)`);
        // Positive control: the values do exist for Accounts (the check is meaningful).
        await A.page.goto('/app/accounts/supplier-payments?tab=all');
        const accountsHtml = await A.page.content();
        check('7 · positive control (Accounts sees the funding amount)', moneyPatterns(FUNDING_PAISE).some((p) => p.test(accountsHtml)), 'funding 22,222.23 visible to Accounts');
      });
    } finally {
      const report = { stamp, deal: seeded ? { id: seeded.dealId, reference: seeded.dealRef, taskId: seeded.taskId } : null, results };
      writeFileSync(join(shotDir, 'purchase-flow-results.json'), JSON.stringify(report, null, 2));
      await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    }
  });
});
