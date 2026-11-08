import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { challengeViaUi, istToday, signInViaUi, totpCode, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Visa build (contract 8 Nov 2026), Track E, test plan 12.5: the real
 * browser journey of the Visa and Passport desk against a disposable local
 * Supabase stack served by the production build.
 *
 *   One booking (accepted) with a sticker visa (4 travellers, documents
 *   needed, jurisdiction Yes · New Delhi), an e-visa (3 travellers, kind
 *   blank) and a passport (1 applicant) -> three tasks at acceptance (V1).
 *    1. Visa A takes all three; the Manager opens them read-only.
 *    2. Sticker: row edit (passport number, date, documents, one "Other"
 *       document, an upload marks a document received); clubbed Confirm
 *       applied for 3 with one company receipt (Accounts B accepts, Visa A
 *       cannot); 1 alone without receipt -> draft -> Send fee to Accounts;
 *       approve two (courier with number; not with us), reject one (reason +
 *       letter, office -> Mark delivered), Apply again -> approve -> handover;
 *       withdraw the not-applied one.
 *    3. E-visa: the desk picks E-visa in the row; Applied without an
 *       appointment; approve with a typed e-mail -> closed; Accounts returns
 *       a fee -> Fix fee -> accepted.
 *    4. Passport: document added by the desk, appointment, applied,
 *       approved, delivered -> task completed.
 *    5. The Sales owner sees each result once on Home and the Deal page
 *       (OK, seen) and Deal History "Visa and passport"; other Sales sees no
 *       notice.
 *    6. Revision (Accounts returns first): remove a traveller and add them
 *       back (new number: a NEW application, lead decision 16), rename
 *       another -> "Booking version 2 changed this task", traveller changed
 *       -> OK, checked; the completed passport task does not block (QB3).
 *    7. Money fence: Purchase and Flight sessions get no visa data; no
 *       commercial or contact marker in any network response of the run.
 *    8. axe at 1280 and 375 px on the queue, each task tab, each popup, the
 *       Deal visa card, the Book now visa drawer and Accounts expenses; no
 *       sideways scroll; keyboard path through row edit and Confirm applied;
 *       200% zoom; reduced motion.
 *
 * Screen labels are the contract's (section 11) where it names them, else
 * Track D's. Booking, Accounts review and the revision edits are SYNTHETIC
 * FIXTURE STEPS through the same database commands the screens call. Skips
 * without a real stack; fails when REQUIRE_REAL_STACK=1 and anything is missing.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(databaseUrl && supabaseUrl && publishableKey && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL, the Supabase URL, publishable key or secret key is missing: the Visa flow must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Visa flow runs only against a loopback Supabase stack and database.');
}

const shotDir = process.env.VISA_FLOW_SHOTS ?? 'test-results/real-journey/visa-flow';
const fileDir = 'test-results/real-journey/visa-flow-files';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const PASSWORD = `E2e-${randomUUID()}-Pw1`;

const USERS = {
  sales: { id: 'a0000000-0000-4000-8000-0000000007e1', email: 'e2e.vflow.sales@example.test', name: 'E2E Visa Sales', role: 'sales', branch: 'DEL' },
  sales2: { id: 'a0000000-0000-4000-8000-0000000007e2', email: 'e2e.vflow.sales2@example.test', name: 'E2E Visa Sales Two', role: 'sales', branch: 'DEL' },
  visaA: { id: 'a0000000-0000-4000-8000-0000000007e3', email: 'e2e.vflow.visa.a@example.test', name: 'E2E Visa Desk A', role: 'visa', branch: 'JDH' },
  accA: { id: 'a0000000-0000-4000-8000-0000000007e4', email: 'e2e.vflow.accounts.a@example.test', name: 'E2E Visa Accounts A', role: 'accounts', branch: 'JDH' },
  accB: { id: 'a0000000-0000-4000-8000-0000000007e5', email: 'e2e.vflow.accounts.b@example.test', name: 'E2E Visa Accounts B', role: 'accounts', branch: 'DEL' },
  manager: { id: 'a0000000-0000-4000-8000-0000000007e6', email: 'e2e.vflow.manager@example.test', name: 'E2E Visa Manager', role: 'manager', branch: 'DEL' },
  purchase: { id: 'a0000000-0000-4000-8000-0000000007e7', email: 'e2e.vflow.purchase@example.test', name: 'E2E Visa Purchase', role: 'purchase', branch: 'JDH' },
  flight: { id: 'a0000000-0000-4000-8000-0000000007e8', email: 'e2e.vflow.flight@example.test', name: 'E2E Visa Flight', role: 'flight', branch: 'JDH' },
} as const;
type UserKey = keyof typeof USERS;

// Markers: Visa, Purchase and Flight must never see the commercial or contact ones.
const SELLING_PAISE = '45678912';
const CONTACT_MOBILE = '9876511122';
const CONTACT_EMAIL = 'e2e.vflow.contact@example.test';
const EVISA_EMAIL = 'e2e.vflow.family@example.test';
const DESK_PASSPORT = 'P9988776';
const TRAVELLERS = [
  { fullName: 'Synthetic Visa One', type: 'adult', seq: 1 },
  { fullName: 'Synthetic Visa Two', type: 'adult', seq: 2 },
  { fullName: 'Synthetic Visa Three', type: 'adult', seq: 3 },
  { fullName: 'Synthetic Visa Four', type: 'child', seq: 4, ageYears: 9 },
];
const STICKER = { country: 'France', purpose: 'Tourism', travelDate: '2027-02-06', applyBy: null, feePaidBy: 'company', notes: null, visaKind: 'sticker',
  jurisdiction: 'yes', jurisdictionPlace: 'New Delhi', documentsNeeded: ['Passport copy (front and back)', 'Photo, white background', 'Bank statement (6 months)'] };
const EVISA = { country: 'United Arab Emirates', purpose: 'Tourism', travelDate: '2026-12-20', applyBy: null, feePaidBy: 'company', notes: null, visaKind: null,
  jurisdiction: null, jurisdictionPlace: null, documentsNeeded: ['Passport copy (front and back)', 'Photo, white background'] };
const PASSPORT = { applicationType: 'renewal', officeCity: 'Jodhpur', neededBy: '2026-12-01', notes: null };

function moneyPatterns(paise: string): RegExp[] {
  const rupees = (Number(paise) / 100).toFixed(2);
  const [whole, dec] = rupees.split('.') as [string, string];
  const indian = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  const western = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = [...new Set([`${indian}.${dec}`, `${western}.${dec}`, `${whole}.${dec}`])]
    .map((v) => new RegExp(`(?<![\\d,])${v.replace(/[.,]/g, (c) => `\\${c}`)}(?![\\d])`));
  out.push(new RegExp(`(?<![0-9a-fA-F])${paise}(?![0-9a-fA-F])`));
  return out;
}
const COMMERCIAL: Array<{ what: string; patterns: RegExp[] }> = [
  { what: 'selling total', patterns: moneyPatterns(SELLING_PAISE) },
  { what: 'contact mobile', patterns: [new RegExp(CONTACT_MOBILE)] },
  { what: 'contact e-mail', patterns: [new RegExp(CONTACT_EMAIL.replace(/\./g, '\\.'))] },
];
const VISA_DATA: Array<{ what: string; patterns: RegExp[] }> = [
  { what: 'e-visa e-mail', patterns: [new RegExp(EVISA_EMAIL.replace(/\./g, '\\.'))] },
  { what: 'desk passport number', patterns: [new RegExp(DESK_PASSPORT)] },
  { what: 'visa reference', patterns: [/VFS-E2E-/] },
];

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const note = (step: string, ok: boolean, detail = '') => results.push({ step, ok, detail });
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
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db(async (c) => (await c.query(sql, params)).rows as T[]);

async function asUser<T = unknown>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  return db(async (client) => {
    await client.query('begin');
    try {
      const now = Math.floor(Date.now() / 1000);
      const claims = { sub: userId, role: 'authenticated', aal: 'aal2', aud: 'authenticated', iat: now, exp: now + 900,
        amr: [{ method: 'password', timestamp: now - 30 }, { method: 'totp', timestamp: now - 30 }] };
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
async function putObject(bucket: string, path: string, bytes: Uint8Array<ArrayBuffer>, mime: string) {
  const { error } = await admin().storage.from(bucket).upload(path, new Blob([bytes], { type: mime }), { contentType: mime, upsert: false });
  if (error) throw new Error(`upload to ${bucket} failed: ${error.message}`);
}
const fakePdf = (size = 2048): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(size));
  out.fill(32);
  out.set(Buffer.from('%PDF-1.4\n% synthetic test file\n'), 0);
  return out;
};
const sha = () => randomBytes(32).toString('hex');

async function prepareUsers(): Promise<Record<UserKey, string>> {
  const env = await q<{ environment: string }>('select environment from public.deployment_settings where id');
  expect(env[0]?.environment, "the Visa flow needs the 'test' deployment environment").toBe('test');
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
      await client.query(`insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
        values ($1, $2, $3, 'active', now()) on conflict (user_id) do nothing`, [u.id, u.name, u.email]);
      await client.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, $2, 'active' from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
         where e.code = 'HOLIDAY_CHACHA' and b.code = $3
           and not exists (select 1 from public.memberships m where m.user_id = $1 and m.branch_id = b.id and m.role_code = $2)`,
        [u.id, u.role, u.branch]);
    }
    // The Manager reads the Delhi branch (same synthetic grant as the fixture Manager).
    await client.query(`insert into public.access_grants (user_id, permission_code, legal_entity_id, branch_id, reason, granted_by, starts_at)
      select $1, 'deal.read', b.legal_entity_id, b.id, 'SYNTHETIC FIXTURE: e2e visa flow Manager', $1, now() - interval '1 minute'
      from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
        and not exists (select 1 from public.access_grants g where g.user_id = $1 and g.permission_code = 'deal.read' and g.revoked_at is null)`,
    [USERS.manager.id]).catch(() => undefined);
    await client.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [Object.values(USERS).map((u) => u.id)]);
  });
  const secrets = {} as Record<UserKey, string>;
  for (const [key, u] of Object.entries(USERS) as Array<[UserKey, (typeof USERS)[UserKey]]>) {
    const c = createClient(supabaseUrl!, publishableKey!, { auth: noPersist });
    const signed = await c.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    if (signed.error) throw new Error(`${key} sign-in failed`);
    const enrolled = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: `vflow-${key}-${Date.now()}` });
    if (enrolled.error) throw new Error(`${key} TOTP enrolment failed`);
    const verified = await c.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: await totpCode(enrolled.data.totp.secret) });
    if (verified.error) throw new Error(`${key} TOTP verification failed`);
    secrets[key] = enrolled.data.totp.secret;
    await c.auth.signOut({ scope: 'local' });
  }
  return secrets;
}

type Booked = { dealId: string; dealRef: string; versionId: string; itemIds: string[]; sticker: string; evisa: string; passport: string };

async function storeIdProof(S: string, dealId: string, seq: number) {
  const bytes = fakePdf();
  const begun = await asUser<{ fileId: string; objectPath: string }>(S, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
    [dealId, seq, randomUUID(), `id-proof-${seq}.pdf`, 'application/pdf', bytes.byteLength, sha()]);
  await putObject('traveller-id-proofs', begun.objectPath, bytes, 'application/pdf');
  await asUser(S, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
}
async function storeAcceptance(S: string, versionId: string) {
  const proof = fakePdf();
  const ev = await asUser<{ evidenceId: string; objectPath: string }>(S, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
    [versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', proof.byteLength, sha()]);
  await putObject('booking-evidence', ev.objectPath, proof, 'application/pdf');
  await asUser(S, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId]);
}

/** SYNTHETIC FIXTURE STEP: the Sales owner confirms the booking through the commands the booking screens call; the visa switch is On (V1). */
async function seedBooking(stamp: number): Promise<Booked> {
  const S = USERS.sales.id;
  const dealRef = `VF-${stamp}`;
  const dealId = (await q<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
     select b.legal_entity_id, b.id, $1, 'E2E Visa flow deal (synthetic)', $2, true
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`,
    [dealRef, S]))[0]!.id;
  await q('update public.workflow_settings set service_items_enabled = true, visa_passport_tasks_enabled = true where id');
  const opened = await asUser<{ versionId: string; rowVersion: number }>(S, 'select public.booking_open_draft($1) as r', [dealId]);
  const v = opened.versionId;
  let rv = opened.rowVersion;
  const itemIds: string[] = [];
  for (const [type, facts] of [['visa', STICKER], ['visa', EVISA], ['passport', PASSPORT]] as const) {
    const added = await asUser<{ rowVersion: number; itemId: string }>(S, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
      [v, rv, type, JSON.stringify(facts), '0', randomUUID()]);
    rv = added.rowVersion;
    itemIds.push(added.itemId);
  }
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [dealId, rv, JSON.stringify(TRAVELLERS)])).rowVersion;
  const nullFacts = { hotelName: null, city: null, checkIn: null, checkOut: null, rooms: null, roomType: null, mealPlan: null, adults: null, children: null,
    inclusions: null, specialRequests: null, purchaseBudgetPaise: null };
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, true) as r', [v, rv, JSON.stringify(nullFacts), SELLING_PAISE])).rowVersion;
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
    [v, rv, JSON.stringify({ destination: 'Synthetic City, France', scope: 'international', start: '2027-02-06', end: '2027-02-15' })])).rowVersion;
  const billing = (await q<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [dealId]))[0];
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r', [v, rv,
    JSON.stringify({ contactName: 'Synthetic Contact', mobile: CONTACT_MOBILE, email: CONTACT_EMAIL, contactConfirmed: true, bookingFor: 'individual', payerDifferent: false, payerName: null }),
    billing ? null : JSON.stringify({ billingName: 'Synthetic Billing Name', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null }),
    0, randomUUID()])).rowVersion;
  const participants: number[][] = [[1, 2, 3, 4], [1, 2, 3], [1]];
  for (const [i, item] of itemIds.entries()) {
    rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r', [item, v, rv, participants[i]])).rowVersion;
  }
  rv = (await asUser<{ rowVersion: number }>(S, 'select public.booking_instalments_save($1, $2, $3::jsonb) as r',
    [v, rv, JSON.stringify([{ seq: 1, label: 'Full payment', amountPaise: SELLING_PAISE, dueDate: '2026-11-01' }])])).rowVersion;
  for (const t of TRAVELLERS) {
    await asUser(S, 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r', [dealId, t.seq, 0,
      JSON.stringify({ dateOfBirth: '1990-05-17', nationality: 'Indian', passportNumber: `Z${2000000 + t.seq}`, passportExpiry: '2031-01-31' })]);
    await storeIdProof(S, dealId, t.seq);
  }
  await storeAcceptance(S, v);
  const ready = await asUser<{ issues: string[]; contentHash: string }>(S, 'select public.booking_readiness($1) as r', [v]);
  expect(ready.issues, 'synthetic visa booking is ready to confirm').toEqual([]);
  await asUser(S, 'select public.booking_confirm($1, $2) as r', [v, ready.contentHash]);
  const tasks = await q<{ id: string }>(
    `select t.id from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
     where t.deal_id = $1 and t.department = 'visa' order by i.item_no`, [dealId]);
  expect(tasks, 'three tasks at acceptance (V1)').toHaveLength(3);
  return { dealId, dealRef, versionId: v, itemIds, sticker: tasks[0]!.id, evisa: tasks[1]!.id, passport: tasks[2]!.id };
}

type AppRow = { id: string; traveller_seq: number; state: string; closed_reason: string | null; superseded_at: string | null; removed_at: string | null };
const apps = (taskId: string) => q<AppRow>(
  'select id, traveller_seq, state, closed_reason, superseded_at, removed_at from public.visa_applications where task_id = $1 order by traveller_seq, created_at', [taskId]);
const current = async (taskId: string, seq: number) => (await apps(taskId)).find((a) => a.traveller_seq === seq && !a.superseded_at && !a.removed_at)!;
const taskStatus = async (taskId: string) => (await q<{ status: string }>('select status from public.fulfilment_tasks where id = $1', [taskId]))[0]!.status;

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
interface Session { context: BrowserContext; page: Page }
async function signIn(browser: Browser, key: UserKey, secret: string, opts: { reducedMotion?: boolean } = {}): Promise<Session> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  await signInViaUi(page, USERS[key].email, PASSWORD);
  await challengeViaUi(page, secret);
  await expect(page).toHaveURL(/\/app(\/|$|\?)/);
  return { context, page };
}
const BODY_READ_MS = 10_000;
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
const leaksIn = (text: string, list: Array<{ what: string; patterns: RegExp[] }>) =>
  list.flatMap((f) => f.patterns.filter((p) => p.test(text)).map((p) => `${f.what} (${p.source})`));
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
async function a11y(page: Page, label: string, opts: { include?: string; shotName?: string } = {}) {
  for (const width of [1280, 375, 640]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : width === 640 ? 430 : 860 });
    await page.waitForTimeout(300);
    if (width !== 640) await axe(page, `${label} @${width}`, opts.include);
    await noSidewaysScroll(page, `${label} @${width === 640 ? '200% zoom' : width}`);
    if (opts.shotName && width !== 640) await shot(page, `${opts.shotName}-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}
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
const taskUrl = (taskId: string, tab = 'work') => `/app/visa/${taskId}?tab=${tab}`;
/** The Passengers table row of a traveller (by name). */
const paxRow = (page: Page, name: string) => page.getByRole('region', { name: /Passengers and documents/ }).first().getByRole('row').filter({ hasText: name }).first();
/** The Appointment table row of a traveller (by name). */
const apptRow = (page: Page, name: string) => page.getByRole('region', { name: /^Appointment/ }).first().getByRole('row').filter({ hasText: name }).first();
const dialog = (page: Page) => page.getByRole('dialog');
async function selectByText(select: Locator, text: RegExp) {
  const options = await select.locator('option').allInnerTexts();
  const i = options.findIndex((o) => text.test(o));
  if (i < 0) throw new Error(`no option matching ${text} (have: ${options.join(' | ')})`);
  await select.selectOption({ index: i });
}
/** Appointment table: "Record decision for {name}" menu -> Approved / Rejected / Withdrawn by customer. */
async function decisionChoice(page: Page, name: string, choice: RegExp) {
  await page.getByRole('button', { name: `Record decision for ${name}` }).click();
  await page.getByRole('menuitem', { name: choice }).click();
}
/** Appointment table: "Mark as applied for {name}". */
const markApplied = (page: Page, name: string) => page.getByRole('button', { name: `Mark as applied for ${name}` }).click();

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------
test.use({ actionTimeout: 20_000, navigationTimeout: 60_000 });

test.describe('Visa and Passport desk: real end-to-end flow (Visa build)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (TEST_DATABASE_URL, Supabase URL and keys).');

  test('sticker, clubbed e-visas and a passport from acceptance to completion, with notices, revision, money fence and accessibility', async ({ browser }) => {
    test.setTimeout(1_800_000);
    mkdirSync(shotDir, { recursive: true });
    mkdirSync(fileDir, { recursive: true });
    const stamp = Date.now();
    const pdf = (name: string) => {
      const p = join(fileDir, `${name}-${stamp}.pdf`);
      writeFileSync(p, fakePdf(4096));
      return p;
    };
    const visaResponses: Array<Promise<{ url: string; body: string; readable: boolean }>> = [];
    const fenceResponses: Array<Promise<{ url: string; body: string; readable: boolean }>> = [];
    let secrets!: Record<UserKey, string>;
    let b!: Booked;
    const contexts: BrowserContext[] = [];
    let V!: Session;
    let SO!: Session;

    try {
      await stepRun('0 · fixture: staff and the accepted booking with three items', async () => {
        secrets = await prepareUsers();
        b = await seedBooking(stamp);
      });

      await stepRun('1 · Visa A takes all three tasks; the Manager opens them read-only', async () => {
        V = await signIn(browser, 'visaA', secrets.visaA, { reducedMotion: true });
        contexts.push(V.context);
        recordResponses(V.page, visaResponses);
        const page = V.page;
        await page.goto('/app/visa');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await a11y(page, 'Visa queue', { shotName: 'visa-queue' });
        for (const taskId of [b.sticker, b.evisa, b.passport]) {
          await page.goto(taskUrl(taskId, 'details'));
          await page.getByRole('button', { name: 'Take this task' }).click();
          await expect.poll(() => taskStatus(taskId), { timeout: 30_000 }).toBe('in_progress');
        }
        for (const tab of ['details', 'work', 'files', 'history']) {
          await page.goto(taskUrl(b.sticker, tab));
          await a11y(page, `Visa task ${tab}`, { shotName: `task-${tab}` });
        }
        const M = await signIn(browser, 'manager', secrets.manager);
        contexts.push(M.context);
        await M.page.goto(taskUrl(b.sticker));
        await expect(M.page.locator('main')).toContainText('View only. The Visa desk does this work.');
        check('1 · Manager sees no Take or Edit', (await M.page.locator('main').getByRole('button', { name: /^(Take this task|Edit)/ }).count()) === 0, 'read-only');
        await expect(M.page.locator('main')).toContainText('Passport shown to the assigned executive');
        await a11y(M.page, 'Manager task view');
      });

      await stepRun('2a · sticker: row edit (passport, date, documents, Other document, upload marks received)', async () => {
        const page = V.page;
        await page.goto(taskUrl(b.sticker));
        // Traveller 1: keyboard path through the row edit (pencil -> first field ... Save -> focus back on the pencil).
        const row1 = paxRow(page, 'Synthetic Visa One');
        const pencil = row1.getByRole('button', { name: /^Edit/ });
        await pencil.focus();
        await page.keyboard.press('Enter');
        const firstFocused = await page.evaluate(() => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? ''));
        check('8 · keyboard · row edit focuses its first field', firstFocused, 'focus moved into the row');
        await row1.getByLabel(/Passport (no|number)/i).fill(DESK_PASSPORT);
        await row1.getByLabel(/Appointment date|Appointment/i).first().fill(istToday(-1));
        for (const box of await row1.getByRole('checkbox').all()) await box.check();
        await row1.getByRole('button', { name: /^Save/ }).click();
        await expect.poll(async () => (await q<{ n: number }>(
          `select count(*)::int as n from public.visa_application_documents d join public.visa_applications a on a.id = d.application_id
           where a.task_id = $1 and a.traveller_seq = 1 and d.status = 'received' and d.removed_at is null`, [b.sticker]))[0]!.n, { timeout: 30_000 }).toBe(3);
        await expect(page.locator('main').getByRole('button', { name: /^Edit/ }).first()).toBeVisible();
        await page.reload();
        check('7 · positive control (the assignee sees the passport number)', (await page.content()).includes(DESK_PASSPORT), 'visible to the assignee');
        expect((await q<{ p: string }>(`select x.passport_number as p from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
          where t.deal_id = $1 and t.seq = 1`, [b.dealId]))[0]!.p).toBe(DESK_PASSPORT);
        // Travellers 2-4: date + documents; traveller 2 also gets an "Other" document, received by an upload.
        for (const name of ['Synthetic Visa Two', 'Synthetic Visa Three', 'Synthetic Visa Four']) {
          const row = paxRow(page, name);
          await row.getByRole('button', { name: /^Edit/ }).click();
          await row.getByLabel(/Appointment date|Appointment/i).first().fill(istToday(-1));
          for (const box of await row.getByRole('checkbox').all()) await box.check();
          await row.getByRole('button', { name: /^Save/ }).click();
          await expect(row.getByRole('button', { name: /^Edit/ })).toBeVisible({ timeout: 30_000 });
        }
        const row2 = paxRow(page, 'Synthetic Visa Two');
        await row2.getByRole('button', { name: /^Edit/ }).click();
        await row2.getByRole('button', { name: /^Add/ }).first().click();
        await selectByText(dialog(page).getByLabel(/Which document|Document/).first(), /Other/);
        await dialog(page).getByLabel('Document name').fill('Synthetic sponsor letter');
        await a11y(page, 'Add document popup', { include: '[role="dialog"]' });
        await dialog(page).getByRole('button', { name: 'Save document' }).click();
        await expect(dialog(page)).toBeHidden({ timeout: 30_000 });
        await paxRow(page, 'Synthetic Visa Two').getByRole('button', { name: /^Upload/ }).first().click();
        await selectByText(dialog(page).getByLabel('Which document'), /Synthetic sponsor letter/);
        await dialog(page).getByLabel('File').setInputFiles(pdf('sponsor-letter'));
        await dialog(page).getByRole('button', { name: 'Upload and save' }).click();
        await expect.poll(async () => (await q<{ s: string }>(
          `select d.status as s from public.visa_application_documents d join public.visa_applications a on a.id = d.application_id
           where a.task_id = $1 and a.traveller_seq = 2 and d.label = 'Synthetic sponsor letter'`, [b.sticker]))[0]?.s, { timeout: 30_000 }).toBe('received');
      });

      await stepRun('2b · sticker: clubbed Confirm applied for 3 with one receipt; 1 alone without receipt -> draft -> Send fee to Accounts', async () => {
        const page = V.page;
        await page.goto(taskUrl(b.sticker));
        const appt = page.getByRole('region', { name: /^Appointment/ }).first();
        for (const name of ['Synthetic Visa One', 'Synthetic Visa Two', 'Synthetic Visa Three']) await apptRow(page, name).getByRole('checkbox').check();
        await expect(appt).toContainText(/3 of \d selected/);
        const confirm = page.getByRole('button', { name: 'Confirm applied' }).first();
        await confirm.click();
        const d = dialog(page);
        const refs = d.getByLabel(/Reference/);
        for (let i = 0; i < 3; i += 1) await refs.nth(i).fill(`VFS-E2E-${stamp}-${i + 1}`);
        await d.getByLabel(/Government fee/).first().fill('6,500');
        // First passenger's fees fill the empty boxes below (never split).
        check('2b · fees copied down', (await d.getByLabel(/Government fee/).nth(2).inputValue()).replace(/[^\d]/g, '').startsWith('6500'), 'copied');
        await selectByText(d.getByLabel('Paid by'), /Company/);
        await selectByText(d.getByLabel('How it was paid'), /UPI/i);
        await d.getByLabel(/receipt/i).first().setInputFiles(pdf('club-receipt'));
        await a11y(page, 'Confirm applied popup', { include: '[role="dialog"]' });
        await d.getByRole('button', { name: 'Confirm applied' }).click();
        await expect.poll(async () => (await apps(b.sticker)).filter((a) => a.state === 'decision_pending').length, { timeout: 30_000 }).toBe(3);
        const club = await q<{ n: number; clubs: number }>('select count(*)::int as n, count(distinct club_id)::int as clubs from public.visa_applications where task_id = $1 and club_id is not null', [b.sticker]);
        check('2b · one club of three', club[0]!.n === 3 && club[0]!.clubs === 1, JSON.stringify(club[0]));
        const entries = await q<{ id: string; expense_status: string; row_version: number }>(
          `select id, expense_status, row_version from public.department_cost_entries where task_id = $1`, [b.sticker]);
        check('2b · three submitted fee entries', entries.length === 3 && entries.every((e) => e.expense_status === 'submitted'), JSON.stringify(entries.map((e) => e.expense_status)));
        // Accounts B accepts (Visa A cannot: no Accounts role); Accounts expenses show the applicant name.
        const A = await signIn(browser, 'accB', secrets.accB);
        contexts.push(A.context);
        await A.page.goto('/app/accounts/expenses');
        await expect(A.page.locator('main')).toContainText(/Applicant:?\s*Synthetic Visa One/);
        await a11y(A.page, 'Accounts expenses');
        for (const e of entries) await asUser(USERS.accB.id, 'select public.expense_record_accept($1, $2, $3) as r', [e.id, e.row_version, randomUUID()]);
        // Traveller 4 alone (Mark as applied), company-paid without receipt -> draft (VL2).
        await page.reload();
        await markApplied(page, 'Synthetic Visa Four');
        const one = dialog(page);
        await one.getByLabel(/Reference/).first().fill(`VFS-E2E-${stamp}-4`);
        await one.getByLabel(/Government fee/).first().fill('3,250');
        await selectByText(one.getByLabel('Paid by'), /Company/);
        await selectByText(one.getByLabel('How it was paid'), /UPI/i);
        await a11y(page, 'Mark as applied popup', { include: '[role="dialog"]' });
        await one.getByRole('button', { name: /Save as applied/ }).click();
        const four = async () => (await q<{ expense_status: string }>(`select e.expense_status from public.department_cost_entries e join public.visa_applications a on a.id = e.application_id
          where a.task_id = $1 and a.traveller_seq = 4`, [b.sticker]))[0]?.expense_status;
        await expect.poll(four, { timeout: 30_000 }).toBe('draft');
        await page.reload();
        await page.getByRole('button', { name: 'Send fee to Accounts' }).first().click();
        await dialog(page).getByLabel(/receipt/i).first().setInputFiles(pdf('receipt-4'));
        await dialog(page).getByRole('button', { name: 'Send to Accounts' }).click();
        await expect.poll(four, { timeout: 30_000 }).toBe('submitted');
      });

      await stepRun('2c · sticker: approve two (courier, not with us), reject one (office -> Mark delivered), Apply again -> applied', async () => {
        const page = V.page;
        const approve = async (name: string, method: RegExp, courier?: string) => {
          await page.goto(taskUrl(b.sticker));
          await decisionChoice(page, name, /Approved/);
          const d = dialog(page);
          await d.getByLabel(/Proof|visa document/i).first().setInputFiles(pdf(`visa-${name.replace(/\s/g, '')}`));
          await selectByText(d.getByLabel('How the passport goes back'), method);
          if (courier) await d.getByLabel('Courier number').fill(courier);
          await d.getByRole('button', { name: 'Save approval' }).click();
          await expect(d).toBeHidden({ timeout: 30_000 });
        };
        await approve('Synthetic Visa One', /courier/i, `AWB${stamp}`);
        await approve('Synthetic Visa Two', /not with us/i);
        await expect.poll(async () => [(await current(b.sticker, 1)).closed_reason, (await current(b.sticker, 2)).closed_reason], { timeout: 30_000 })
          .toEqual(['courier_dispatched', 'not_with_us']);
        // Reject traveller 3 (reason + refusal letter), handover office, Mark delivered.
        await page.goto(taskUrl(b.sticker));
        await decisionChoice(page, 'Synthetic Visa Three', /Rejected/);
        const r = dialog(page);
        await r.getByLabel(/Reason/).first().fill('Synthetic refusal: bank statement too short');
        await r.getByLabel('Refusal letter').setInputFiles(pdf('refusal'));
        await selectByText(r.getByLabel('How the passport goes back'), /office/i);
        await a11y(page, 'Reject popup', { include: '[role="dialog"]' });
        await r.getByRole('button', { name: 'Save rejection' }).click();
        await expect.poll(async () => (await current(b.sticker, 3)).state, { timeout: 30_000 }).toBe('refused');
        await page.reload();
        await page.locator('main').getByRole('button', { name: /^Mark delivered/ }).first().click();
        await dialog(page).getByLabel('Delivered on').fill(istToday());
        await dialog(page).getByRole('button', { name: 'Save delivery' }).click();
        await expect.poll(async () => (await apps(b.sticker)).find((a) => a.traveller_seq === 3)!.closed_reason, { timeout: 30_000 }).toBe('delivered');
        // Apply again -> new application -> applied -> approved -> not with us.
        await page.reload();
        await page.getByRole('button', { name: 'Apply again for Synthetic Visa Three' }).click();
        await dialog(page).getByRole('button', { name: 'Start a new application' }).click();
        await expect.poll(async () => (await apps(b.sticker)).filter((a) => a.traveller_seq === 3).length, { timeout: 30_000 }).toBe(2);
        await expect(page.locator('main')).toContainText('Second application');
        const second = await current(b.sticker, 3);
        // SYNTHETIC FIXTURE STEP for speed: the second application is applied and approved through the commands the popups call.
        const ws = await asUser<{ applicants: Array<{ applicationId: string; rowVersion: number; documents: Array<{ documentId: string }> }> }>(USERS.visaA.id,
          'select public.visa_workspace($1) as r', [b.sticker]);
        const s2 = ws.applicants.find((a) => a.applicationId === second.id)!;
        await asUser(USERS.visaA.id, 'select public.visa_application_set_row($1, $2, $3::jsonb, $4) as r', [s2.applicationId, s2.rowVersion,
          JSON.stringify({ appointmentDate: istToday(), documents: s2.documents.map((x) => ({ documentId: x.documentId, received: true })) }), randomUUID()]);
        await asUser(USERS.visaA.id, 'select public.visa_applications_apply($1, $2::jsonb, $3) as r', [b.sticker, JSON.stringify({ applicants: [{
          applicationId: s2.applicationId, expectedRowVersion: s2.rowVersion + 1, reference: `VFS-E2E-${stamp}-3B`, appliedOn: istToday(), governmentFeePaise: '650000',
          serviceFeePaise: null }], paidBy: 'customer_direct', remark: null }), randomUUID()]);
        // The second application stays open (waiting for a decision) until after the booking change of step 6.
        await expect.poll(async () => (await current(b.sticker, 3)).state, { timeout: 30_000 }).toBe('decision_pending');
      });

      await stepRun('3 · e-visa: kind chosen in the row; applied without appointment; approve with a typed e-mail; withdraw one; Fix fee after a return', async () => {
        const page = V.page;
        await page.goto(taskUrl(b.evisa));
        for (const name of ['Synthetic Visa One', 'Synthetic Visa Two']) {
          const row = paxRow(page, name);
          await row.getByRole('button', { name: /^Edit/ }).click();
          await selectByText(row.getByLabel(/Visa type|E-visa or sticker/i).first(), /E-visa/);
          for (const box of await row.getByRole('checkbox').all()) await box.check();
          await row.getByRole('button', { name: /^Save/ }).click();
          await expect(row.getByRole('button', { name: /^Edit/ })).toBeVisible({ timeout: 30_000 });
        }
        for (const name of ['Synthetic Visa One', 'Synthetic Visa Two']) await apptRow(page, name).getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Confirm applied' }).first().click();
        const d = dialog(page);
        const refs = d.getByLabel(/Reference/);
        for (let i = 0; i < 2; i += 1) await refs.nth(i).fill(`VFS-E2E-${stamp}-E${i + 1}`);
        await d.getByLabel(/Government fee/).first().fill('4,000');
        await selectByText(d.getByLabel('Paid by'), /Company/);
        await selectByText(d.getByLabel('How it was paid'), /UPI/i);
        await d.getByLabel(/receipt/i).first().setInputFiles(pdf('evisa-receipt'));
        await d.getByRole('button', { name: 'Confirm applied' }).click();
        await expect.poll(async () => (await apps(b.evisa)).filter((a) => a.state === 'decision_pending').length, { timeout: 30_000 }).toBe(2);
        // Approve traveller 1 with the typed e-mail (empty by default, QB2).
        await page.reload();
        await decisionChoice(page, 'Synthetic Visa One', /Approved/);
        const ap = dialog(page);
        await expect(ap.getByLabel('Customer e-mail')).toHaveValue('');
        await expect(ap).toContainText('Record where you sent the e-visa. The CRM does not send it.');
        await ap.getByLabel(/Proof|visa document/i).first().setInputFiles(pdf('evisa'));
        await ap.getByLabel('Customer e-mail').fill(EVISA_EMAIL);
        await a11y(page, 'Approve e-visa popup', { include: '[role="dialog"]' });
        await ap.getByRole('button', { name: 'Save approval' }).click();
        await expect.poll(async () => (await current(b.evisa, 1)).closed_reason, { timeout: 30_000 }).toBe('evisa_sent');
        await page.reload();
        await expect(page.locator('main')).toContainText(`E-visa sent to ${EVISA_EMAIL}`);
        // Traveller 3 was never applied: Withdrawn by customer from the row.
        await page.getByRole('button', { name: 'More for Synthetic Visa Three' }).click();
        await page.getByRole('menuitem', { name: 'Withdrawn by customer' }).click();
        const w = dialog(page);
        await w.getByLabel('Reason').fill('Synthetic: the customer is not travelling');
        await w.getByLabel('The customer has been told').check();
        await a11y(page, 'Withdraw popup', { include: '[role="dialog"]' });
        await w.getByRole('button', { name: 'Save withdrawal' }).click();
        await expect.poll(async () => (await current(b.evisa, 3)).closed_reason, { timeout: 30_000 }).toBe('customer_informed');
        // Accounts A returns traveller 2's fee; Fix fee resubmits; Accounts B accepts.
        const fee = (await q<{ id: string; row_version: number }>(`select e.id, e.row_version from public.department_cost_entries e
          join public.visa_applications a on a.id = e.application_id where a.task_id = $1 and a.traveller_seq = 2`, [b.evisa]))[0]!;
        await asUser(USERS.accA.id, 'select public.expense_record_return($1, $2, $3, $4) as r', [fee.id, fee.row_version, 'Synthetic: receipt shows another amount', randomUUID()]);
        await page.reload();
        await page.getByRole('button', { name: 'Fix fee' }).first().click();
        const fx = dialog(page);
        await expect(fx).toContainText('Synthetic: receipt shows another amount');
        await fx.getByLabel('Amount').fill('3,900');
        await fx.getByLabel(/receipt/i).first().setInputFiles(pdf('evisa-receipt-2'));
        await a11y(page, 'Fix fee popup', { include: '[role="dialog"]' });
        await fx.getByRole('button', { name: 'Send to Accounts' }).click();
        const status = async () => (await q<{ expense_status: string; row_version: number; amount_paise: string }>(
          'select expense_status, row_version, amount_paise::text from public.department_cost_entries where id = $1', [fee.id]))[0]!;
        await expect.poll(async () => (await status()).expense_status, { timeout: 30_000 }).toBe('submitted');
        check('3 · fixed amount', (await status()).amount_paise === '390000', (await status()).amount_paise);
        await asUser(USERS.accB.id, 'select public.expense_record_accept($1, $2, $3) as r', [fee.id, (await status()).row_version, randomUUID()]);
        // Traveller 2: approve too (keeps the task moving; e-visa closes at once).
        await page.reload();
        await decisionChoice(page, 'Synthetic Visa Two', /Approved/);
        await dialog(page).getByLabel(/Proof|visa document/i).first().setInputFiles(pdf('evisa-2'));
        await dialog(page).getByLabel('Customer e-mail').fill(EVISA_EMAIL);
        await dialog(page).getByRole('button', { name: 'Save approval' }).click();
        await expect.poll(() => taskStatus(b.evisa), { timeout: 30_000 }).toBe('completed');
      });

      await stepRun('4 · passport: document added by the desk, appointment, applied, approved, delivered -> completed', async () => {
        const page = V.page;
        await page.goto(taskUrl(b.passport));
        const row = paxRow(page, 'Synthetic Visa One');
        await row.getByRole('button', { name: /^Edit/ }).click();
        await row.getByRole('button', { name: /^Add/ }).first().click();
        await selectByText(dialog(page).getByLabel(/Which document|Document/).first(), /Old passports/);
        await dialog(page).getByLabel('Already received').check();
        await dialog(page).getByRole('button', { name: 'Save document' }).click();
        await expect(dialog(page)).toBeHidden({ timeout: 30_000 });
        await paxRow(page, 'Synthetic Visa One').getByLabel(/Appointment date|Appointment/i).first().fill(istToday());
        await paxRow(page, 'Synthetic Visa One').getByRole('button', { name: /^Save/ }).click();
        // 11.1: saving the open row must not undo a document added as received through the popup meanwhile.
        const docStatus = async () => (await q<{ s: string }>(`select d.status as s from public.visa_application_documents d
          join public.visa_applications a on a.id = d.application_id where a.task_id = $1 and d.catalogue_code = 'old_passports'`, [b.passport]))[0]?.s;
        await expect.poll(async () => (await q<{ d: string | null }>('select appointment_date::text as d from public.visa_applications where task_id = $1', [b.passport]))[0]?.d,
          { timeout: 30_000 }).not.toBeNull();
        const kept = await docStatus();
        check('4 · row Save keeps a document added as received meanwhile', kept === 'received', `status after the row Save: ${kept}`);
        if (kept !== 'received') {
          await page.reload();
          const again = paxRow(page, 'Synthetic Visa One');
          await again.getByRole('button', { name: /^Edit/ }).click();
          for (const box of await again.getByRole('checkbox').all()) await box.check();
          await again.getByRole('button', { name: /^Save/ }).click();
          await expect.poll(docStatus, { timeout: 30_000 }).toBe('received');
        }
        await page.reload();
        await markApplied(page, 'Synthetic Visa One');
        await dialog(page).getByLabel(/Reference/).first().fill(`PSK-E2E-${stamp}`);
        await dialog(page).getByLabel(/Government fee/).first().fill('1,500');
        await selectByText(dialog(page).getByLabel('Paid by'), /Customer/);
        await dialog(page).getByRole('button', { name: /Save as applied/ }).click();
        await expect.poll(async () => (await current(b.passport, 1)).state, { timeout: 30_000 }).toBe('decision_pending');
        await page.reload();
        await decisionChoice(page, 'Synthetic Visa One', /Approved/);
        await dialog(page).getByLabel('Proof of the passport').setInputFiles(pdf('passport-issued'));
        await selectByText(dialog(page).getByLabel('How the passport goes back'), /executive/i);
        await dialog(page).getByRole('button', { name: 'Save approval' }).click();
        await expect.poll(async () => (await current(b.passport, 1)).state, { timeout: 30_000 }).toBe('issued');
        await page.reload();
        await page.locator('main').getByRole('button', { name: /^Mark delivered/ }).first().click();
        await dialog(page).getByLabel('Delivered on').fill(istToday());
        await a11y(page, 'Mark delivered popup', { include: '[role="dialog"]' });
        await dialog(page).getByRole('button', { name: 'Save delivery' }).click();
        await expect.poll(() => taskStatus(b.passport), { timeout: 30_000 }).toBe('completed');
      });

      await stepRun('5 · the Sales owner sees each result once (Home, Deal page OK, seen, Deal History); other Sales none', async () => {
        SO = await signIn(browser, 'sales', secrets.sales);
        contexts.push(SO.context);
        recordResponses(SO.page, fenceResponses);
        await SO.page.goto('/app');
        await expect(SO.page.locator('main')).toContainText('Visa results to see');
        await SO.page.goto(`/app/deals/${b.dealId}?tab=services`);
        const card = SO.page.getByRole('region', { name: 'Visa results' });
        await expect(card).toBeVisible();
        const notices = await q<{ n: number }>('select count(*)::int as n from public.visa_result_notices where deal_id = $1', [b.dealId]);
        check('5 · one notice per outcome', notices[0]!.n === 6, `${notices[0]!.n} notices (sticker 1,2 approved, 3 rejected; e-visa 1,2; passport 1)`);
        await a11y(SO.page, 'Deal visa card', { shotName: 'deal-visa-card' });
        while ((await card.getByRole('button', { name: 'OK, seen' }).count()) > 0) {
          await card.getByRole('button', { name: 'OK, seen' }).first().click();
          await SO.page.waitForTimeout(500);
        }
        await expect.poll(async () => (await q<{ n: number }>('select count(*)::int as n from public.visa_result_notices where deal_id = $1 and seen_at is null', [b.dealId]))[0]!.n,
          { timeout: 30_000 }).toBe(0);
        await SO.page.goto(`/app/deals/${b.dealId}?tab=history`);
        await expect(SO.page.locator('main')).toContainText('Visa and passport');
        await expect(SO.page.locator('main')).toContainText(/Applied together: 3 travellers/);
        const S2 = await signIn(browser, 'sales2', secrets.sales2);
        contexts.push(S2.context);
        await S2.page.goto('/app');
        // Other Sales has nothing to see: the Home count is 0 or not applicable (a row reading 0 is allowed) and no notice reaches them.
        const s2Home = await asUser<{ salesVisaResultsToSee: number | null }>(USERS.sales2.id, 'select public.visa_home_counts() as r');
        check('5 · other Sales has no visa results to see', (s2Home.salesVisaResultsToSee ?? 0) === 0, `count ${s2Home.salesVisaResultsToSee}`);
        const s2Deal = await asUser<{ notices?: unknown[] } | null>(USERS.sales2.id, 'select public.deal_visa_summary($1) as r', [b.dealId]);
        check('5 · other Sales gets no notices for the Deal', (s2Deal?.notices ?? []).length === 0, JSON.stringify(s2Deal?.notices ?? null).slice(0, 200));
      });

      await stepRun('6 · revision: remove + re-add a traveller (new application), rename another -> OK, checked; completed passport task does not block', async () => {
        // SYNTHETIC FIXTURE STEP: Accounts returns, the Sales owner revises through the booking commands.
        const S = USERS.sales.id;
        await asUser(USERS.accA.id, 'select public.accounts_review_return($1, $2, $3) as r', [b.versionId, 'Synthetic return: travellers change', randomUUID()]);
        const opened = await asUser<{ versionId: string; rowVersion: number }>(S, 'select public.booking_open_revision($1) as r', [b.versionId]);
        const high = (await asUser<{ travellerSeqHigh: number }>(S, 'select public.booking_form_get($1) as r', [b.dealId])).travellerSeqHigh;
        check('6 · travellerSeqHigh', high === 4, String(high));
        const next = [
          { fullName: 'Synthetic Visa One', type: 'adult', seq: 1 },
          { fullName: 'Synthetic Visa Two', type: 'adult', seq: 2 },
          { fullName: 'Synthetic Visa Third', type: 'adult', seq: 3 },
          { fullName: 'Synthetic Visa Four', type: 'child', seq: 5, ageYears: 9 },
        ];
        let rv = (await asUser<{ rowVersion: number }>(S, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [b.dealId, opened.rowVersion, JSON.stringify(next)])).rowVersion;
        await asUser(S, 'select public.traveller_identity_save($1, $2, $3, $4::jsonb) as r', [b.dealId, 5, 0,
          JSON.stringify({ dateOfBirth: '2017-05-17', nationality: 'Indian', passportNumber: 'Z2000005', passportExpiry: '2031-01-31' })]);
        await storeIdProof(S, b.dealId, 5);
        await storeIdProof(S, b.dealId, 3);
        rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r', [b.itemIds[0], opened.versionId, rv, [1, 2, 3, 5]])).rowVersion;
        rv = (await asUser<{ rowVersion: number }>(S, 'select public.service_item_travellers_save($1, $2, $3, $4::integer[]) as r', [b.itemIds[1], opened.versionId, rv, [1, 2, 3]])).rowVersion;
        await asUser(S, 'select public.booking_classify_revision($1, $2, $3) as r', [opened.versionId, rv, 'customer_material']);
        await storeAcceptance(S, opened.versionId);
        const ready = await asUser<{ issues: string[]; contentHash: string }>(S, 'select public.booking_readiness($1) as r', [opened.versionId]);
        check('6 · revision ready (completed visa/passport tasks do not block, QB3)', ready.issues.length === 0, ready.issues.join(','));
        await asUser(S, 'select public.booking_confirm($1, $2) as r', [opened.versionId, ready.contentHash]);
        const sticker = await apps(b.sticker);
        check('6 · re-added traveller has a NEW application (no relink by name)', sticker.some((a) => a.traveller_seq === 5) && sticker.some((a) => a.traveller_seq === 4 && a.removed_at),
          JSON.stringify(sticker.map((a) => [a.traveller_seq, a.state, !!a.removed_at])));
        const page = V.page;
        await page.goto(taskUrl(b.sticker));
        await expect(page.locator('main')).toContainText(/Booking version 2 changed this task/);
        await expect(page.locator('main')).toContainText('Traveller changed');
        await a11y(page, 'Booking changes banner');
        await page.getByRole('button', { name: 'OK, checked' }).first().click();
        await expect.poll(async () => (await q<{ s: string }>('select traveller_name_snapshot as s from public.visa_applications where task_id = $1 and traveller_seq = 3 and superseded_at is null', [b.sticker]))[0]?.s,
          { timeout: 30_000 }).toBe('Synthetic Visa Third');
        // Finish the sticker task: approve the second application (handover not with us); the removed traveller 4 (applied)
        // and the new application of seq 5 are withdrawn with the customer told (VL1: removed applied blocks until closed).
        await page.reload();
        await decisionChoice(page, 'Synthetic Visa Third', /Approved/);
        await dialog(page).getByLabel(/Proof|visa document/i).first().setInputFiles(pdf('visa-3b'));
        await selectByText(dialog(page).getByLabel('How the passport goes back'), /not with us/i);
        await dialog(page).getByRole('button', { name: 'Save approval' }).click();
        await expect.poll(async () => (await current(b.sticker, 3)).closed_reason, { timeout: 30_000 }).toBe('not_with_us');
        const ws = await asUser<{ applicants: Array<{ applicationId: string; seq: number; rowVersion: number; closed: unknown }> }>(USERS.visaA.id,
          'select public.visa_workspace($1) as r', [b.sticker]);
        for (const a of ws.applicants.filter((x) => (x.seq === 4 || x.seq === 5) && !x.closed)) {
          await asUser(USERS.visaA.id, 'select public.visa_application_withdraw($1, $2, $3::jsonb, $4) as r', [a.applicationId, a.rowVersion,
            JSON.stringify({ reason: 'Synthetic: trip shortened', customerInformed: true }), randomUUID()]);
        }
        await expect.poll(() => taskStatus(b.sticker), { timeout: 30_000 }).toBe('completed');
      });

      await stepRun('7 · money fence: Visa saw no commercial or contact marker; Purchase and Flight see no visa data', async () => {
        const vb = await Promise.all(visaResponses);
        const vHits = vb.flatMap((x) => leaksIn(x.body, COMMERCIAL).map((l) => `${new URL(x.url).pathname}: ${l}`));
        check('7 · Visa responses carry no commercial or contact marker', vHits.length === 0 && vb.filter((x) => x.readable).length >= 8,
          vHits.length ? [...new Set(vHits)].slice(0, 10).join('; ') : `${vb.filter((x) => x.readable).length} readable responses clean`);
        for (const key of ['purchase', 'flight'] as const) {
          const S = await signIn(browser, key, secrets[key]);
          contexts.push(S.context);
          recordResponses(S.page, fenceResponses);
          for (const path of ['/app', '/app/visa', taskUrl(b.sticker), taskUrl(b.evisa), taskUrl(b.passport), `/app/deals/${b.dealId}`]) {
            await S.page.goto(path);
            await S.page.waitForLoadState('networkidle');
            const found = leaksIn(await S.page.content(), [...COMMERCIAL, ...VISA_DATA]);
            check(`7 · ${key} page ${path}`, found.length === 0, found.length ? found.join(', ') : 'clean');
          }
        }
        const bodies = await Promise.all(fenceResponses);
        const hits = bodies.flatMap((x) => leaksIn(x.body, VISA_DATA).map((l) => `${new URL(x.url).pathname}: ${l}`));
        check('7 · no visa data in Sales/Purchase/Flight responses', hits.length === 0, hits.length ? [...new Set(hits)].slice(0, 10).join('; ') : 'clean');
        // The positive control (the assignee sees the passport number) runs in step 2a, while the task is open: a completed
        // task has no assignee who can work it (section 4 VA), so nobody gets the identity object then.
      });

      await stepRun('8 · Book now visa drawer: axe at 1280 and 375', async () => {
        await SO.page.goto(`/app/deals/${b.dealId}/book`);
        const edit = SO.page.getByRole('button', { name: /Visa|France/ }).first();
        if (await edit.isVisible().catch(() => false)) await edit.click();
        await a11y(SO.page, 'Book now visa drawer', { shotName: 'book-now-visa' });
      });
    } finally {
      writeFileSync(join(shotDir, 'visa-flow-results.json'), JSON.stringify({ stamp, deal: b?.dealRef, results }, null, 2));
      await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    }
  });
});
