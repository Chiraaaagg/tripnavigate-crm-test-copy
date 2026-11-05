import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { cspRecorder, enrolTotpViaUi, istToday, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * B1.2 Phase E browser journey: a Bitrix Lead becomes an accepted quotation,
 * then a booking, against a REAL local Supabase stack served by the
 * production build (playwright.real.config.ts, project real-journey). The
 * lead runs it; it is never run against a hosted database.
 *
 * The Sales owner types EVERYTHING about the quotation in the browser:
 * Create quotation on the Lead page, trip and travellers, contact, a hotel,
 * the option name, a priced line with an estimated cost, the typed total and
 * a payment schedule; marks it ready and sent; uploads the customer's written
 * acceptance and marks it accepted. The page waits for the Bitrix Deal. Then
 * a Bitrix stand-in (SQL only, like b11-journey's fixtures) stores the Deal
 * Sales made from the Lead, at "Won - Payment Received" with the Lead's
 * Bitrix id. Sales links it, presses "Start booking from this quotation",
 * completes the three Book now steps (contact confirmation, billing,
 * travellers with an ID proof per adult and the consent tick) and submits;
 * one task per sold service appears. A Purchase user sees no quotation and no
 * quotation price.
 *
 * Fixture steps (synthetic, local only, never user-entered quotation or
 * booking facts): the synthetic finance entity and users of the Accounts
 * journey, one run Purchase user, a run Lead manifest, the Lead header and the
 * Deal header as the Bitrix sync would store them, and the
 * service_items_enabled switch and the local real-Deal booking gate
 * (booking_settings.real_booking_enabled; the linked Deal has the Bitrix
 * shape) for the run, both restored afterwards. Who takes part in the hotel is
 * ticked by hand on step 2 (the travellers did not exist at acceptance).
 *
 * Skips without a real stack; fails (never skips) when REQUIRE_REAL_STACK=1.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL or the secret key is missing: the B1.2 quotation journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The B1.2 quotation journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const BRANCH_CODE = 'FBR';
const PORTAL = 'SYNTHETIC_MEMBER_0001';
const SYNTHETIC_INTAKE_CONFIG = 'c0000000-0000-4000-8000-000000000001';
const USERS = {
  a: { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test', name: 'Synthetic Accounts Finance A' },
  b: { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test', name: 'Synthetic Accounts Finance B' },
  sales: { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test', name: 'Synthetic Sales Finance' },
} as const;
const shotDir = 'test-results/real-journey/b12-quote';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);

let switchWasOn: boolean | null = null;
let realBookingWasOn: boolean | null = null;
const manifestIds: string[] = [];

async function loadFixture(fixtureFile: string) {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the B1.2 journey needs the 'test' deployment environment").toBe('test');
  });
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  for (const user of Object.values(USERS)) {
    const { error } = await admin.auth.admin.createUser({ id: user.id, email: user.email, password: fixturePassword!, email_confirm: true });
    if (error && !/already/i.test(error.message)) throw new Error(`could not create ${user.email}: ${error.message}`);
  }
  await db(async (client) => {
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
    await client.query('delete from auth.mfa_factors where user_id = any($1::uuid[])', [Object.values(USERS).map((u) => u.id)]);
    const { rows: s } = await client.query<{ on: boolean }>('select service_items_enabled as "on" from public.workflow_settings where id');
    switchWasOn = s[0]!.on;
    await client.query(
      `select set_config('tripnavigate.change_reason', 'b12-quote-to-booking.real.e2e.ts: switch on for the run', false);
       update public.workflow_settings set service_items_enabled = true where id`,
    );
    // The linked Deal has the Bitrix (non-synthetic) shape, so the local stack's real-Deal booking gate is opened for the run.
    const { rows: r } = await client.query<{ on: boolean }>('select real_booking_enabled as "on" from public.booking_settings where id');
    realBookingWasOn = r[0]!.on;
    await client.query(
      `select set_config('tripnavigate.change_reason', 'b12-quote-to-booking.real.e2e.ts: local real-Deal booking gate on for the run', false);
       update public.booking_settings set real_booking_enabled = true where id`,
    );
  });
}

/** A Purchase user of the synthetic branch, for this run only. */
async function runPurchaseUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `b12-quote.purchase.${tag}@example.test`;
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  const created = await admin.auth.admin.createUser({ email, password: fixturePassword!, email_confirm: true });
  if (created.error) throw new Error(`could not create ${email}: ${created.error.message}`);
  const id = created.data.user!.id;
  await db(async (client) => {
    await client.query(`insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at) values ($1, $2, $3, 'active', now())`, [id, `Synthetic Purchase ${tag}`, email]);
    await client.query(
      `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
       select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.legal_entity_id = $2 and b.code = $3`,
      [id, ENTITY_ID, BRANCH_CODE],
    );
  });
  return { id, email };
}

/** The Bitrix inbox row the sync records for an event (service role, like the webhook). */
async function inboxRow(eventType: 'ONCRMLEADADD' | 'ONCRMDEALADD', sourceId: number): Promise<string> {
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  const recorded = await admin.rpc('integration_record_bitrix_event', { p_member_id: PORTAL, p_event_type: eventType, p_deal_id: sourceId, p_source_ts: Math.floor(Date.now() / 1000) });
  if (recorded.error) throw new Error(`inbox ${eventType}: ${recorded.error.message}`);
  return (recorded.data as { inboxId: string }).inboxId;
}

/** Bitrix stand-in: the Lead header as integration_apply_bitrix_lead stores it (header only). */
async function bitrixLead(sourceLeadId: number, title: string): Promise<string> {
  const inboxId = await inboxRow('ONCRMLEADADD', sourceLeadId);
  return db(async (client) => {
    await client.query(
      `select public.integration_manifest_close(m.id, 'b12-quote-to-booking') from public.intake_manifests m
       where m.config_id = $1 and m.source_object = 'lead' and m.status = 'active'`,
      [SYNTHETIC_INTAKE_CONFIG],
    );
    const { rows: m } = await client.query<{ r: { manifestId: string } }>(
      `select public.integration_manifest_create($1, 'lead', 'WEBFORM', $2::date,
         $2::date::timestamp at time zone 'Asia/Kolkata', ($2::date::timestamp at time zone 'Asia/Kolkata') + interval '1 day',
         $3::bigint[], 'b12-quote-to-booking') as r`,
      [SYNTHETIC_INTAKE_CONFIG, istToday(), [sourceLeadId]],
    );
    const manifestId = m[0]!.r.manifestId;
    manifestIds.push(manifestId);
    const { rows } = await client.query<{ id: string }>(
      `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
         source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, manifest_id)
       select b.legal_entity_id, b.id, 'BXL-' || $1::bigint, $2, $3, $4, $1, 'NEW', 'WEBFORM', now(), now(), now(), now(), $5, $6
       from public.branches b where b.legal_entity_id = $7 and b.code = $8 returning id`,
      [sourceLeadId, title, USERS.sales.id, PORTAL, inboxId, manifestId, ENTITY_ID, BRANCH_CODE],
    );
    expect(rows, `synthetic Bitrix Lead BXL-${sourceLeadId}`).toHaveLength(1);
    return rows[0]!.id;
  });
}

/** Bitrix stand-in: the Deal Sales made from the Lead, stored at "Won - Payment Received" with the Lead's Bitrix id. */
async function bitrixDealFromLead(sourceDealId: number, sourceLeadId: number, title: string): Promise<string> {
  const inboxId = await inboxRow('ONCRMDEALADD', sourceDealId);
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
         source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at, source_modified_at,
         last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id, source_lead_id)
       select b.legal_entity_id, b.id, 'BX-' || $1::bigint, $2, $3, false,
         'bitrix', $4, $1, 'UC_AD0SLH', 0, now(), now(), now(), now(), $5, 9001, $6
       from public.branches b where b.legal_entity_id = $7 and b.code = $8 returning id`,
      [sourceDealId, title, USERS.sales.id, PORTAL, inboxId, sourceLeadId, ENTITY_ID, BRANCH_CODE],
    );
    expect(rows, `synthetic Bitrix Deal BX-${sourceDealId}`).toHaveLength(1);
    return rows[0]!.id;
  });
}

async function signInAndEnrol(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await signInViaUi(page, email, fixturePassword!);
  await enrolTotpViaUi(page);
  await expect(page).toHaveURL(/\/app$/);
  return page;
}

// Booking form (owner-approved preview, 22 October 2026; Book now v2): three steps on one screen; the cards
// save themselves and the footer only moves between steps.
const STEP_NAME = { travellers: 'Customer & passengers', stay: 'Trip & services', finish: 'Price & Bill To' } as const;
const goToStep = async (page: Page, next: string) => {
  await page.getByRole('button', { name: next === STEP_NAME.stay ? 'Go to step 2' : 'Go to step 3' }).click();
  await expect(page).toHaveURL(new RegExp(`/book/${next === STEP_NAME.stay ? 'stay' : 'finish'}`), { timeout: 30_000 });
};
const CONTACT_TICK = 'I confirmed the contact details with the customer';
const SUBMIT_BUTTON = 'Submit booking and create tasks';
const SUBMIT_DIALOG = 'Submit this booking and create tasks?';
/** Open one of the six quotation parts (G1) when it is closed (its heading button controls `{part}-body`); an open part stays open. */
type PartKey = 'details' | 'contact' | 'services' | 'narrative' | 'money' | 'plan';
const openPart = async (page: Page, part: PartKey) => {
  const toggle = page.locator(`button[aria-controls="${part}-body"]`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
};
const syntheticPdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
const saved = (page: Page, section: string) => page.locator(`section#${section}`).getByRole('status').filter({ hasText: 'Saved. Nothing has been sent or booked.' });

test.describe('B1.2 quotation to booking journey (real local stack)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and secret key).');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    if (!configured) return;
    await db(async (client) => {
      if (manifestIds.length > 0) await client.query(`select public.integration_manifest_close(id, 'b12-quote-to-booking') from unnest($1::uuid[]) as id`, [manifestIds]);
      if (switchWasOn === null) return;
      await client.query(`select set_config('tripnavigate.change_reason', 'b12-quote-to-booking.real.e2e.ts: restore the switches after the run', false)`);
      await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [switchWasOn]);
      if (realBookingWasOn !== null) await client.query('update public.booking_settings set real_booking_enabled = $1 where id', [realBookingWasOn]);
    });
  });

  test('Lead → quotation typed in the browser → sent → accepted → Bitrix Deal linked → booking submitted; Purchase sees no quotation money', async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    mkdirSync(shotDir, { recursive: true });
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const sourceLeadId = 700_000_000 + Number(tag.slice(-6)) * 10;
    const sourceDealId = sourceLeadId + 1;
    const start = istToday(30);
    const end = istToday(33);
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');

    const leadId = await test.step('fixture: synthetic entity and users, the switch on, a Bitrix Lead header', async () => {
      await loadFixture(fixtureFile);
      return bitrixLead(sourceLeadId, `Synthetic Goa family trip ${tag}`);
    });

    const salesContext = await csp.track(browser, 'sales');
    const sales = await signInAndEnrol(salesContext, USERS.sales.email);
    let versionId = '';

    await test.step('Lead page: New quotation, then Create quotation opens the editor of version 1', async () => {
      await sales.goto(`/app/leads/${leadId}`);
      // Direction A (FP-015): the header primary "New quotation" opens the Quotations tab, where the create form lives.
      const primary = sales.getByRole('link', { name: 'New quotation' });
      await expect(primary).toHaveCount(1);
      await primary.click();
      await expect(sales).toHaveURL(new RegExp(`/app/leads/${leadId}\\?tab=quotations$`), { timeout: 30_000 });
      const card = sales.getByRole('region', { name: 'Quotations' });
      await expect(card).toContainText('No quotations yet.');
      await card.getByLabel('Quotation title').fill(`Goa for the synthetic family ${tag}`);
      await card.getByRole('button', { name: 'Create quotation' }).click();
      await expect(sales).toHaveURL(/\/app\/quotations\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      versionId = sales.url().split('/').pop()!;
      // Direction A (QU-02, DA-41): an untouched version 1 says "Not started"; the versions list says "Draft".
      await expect(sales.locator('main')).toContainText('Quotation status: Not started');
      await expect(sales.getByRole('button', { name: 'Check and mark ready' })).toHaveCount(1);
      // Nothing red before the check.
      await expect(sales.locator('main')).not.toContainText('To finish before sharing');
    });

    await test.step('editor parts: trip, travellers, contact, a hotel, day plan (each part opened, then saved)', async () => {
      await openPart(sales, 'details');
      await sales.locator('#q-details-destination').fill('Goa');
      await sales.locator('#q-details-tripScope').selectOption('domestic');
      await sales.locator('#q-details-tripStart').fill(start);
      await sales.locator('#q-details-tripEnd').fill(end);
      await sales.locator('#q-details-adults').fill('2');
      // The validity date is kept editable and set by the server when the quotation is made: 7 days after that day (IST).
      const ist = new Date(Date.now() + 5.5 * 3_600_000);
      ist.setUTCDate(ist.getUTCDate() + 7);
      await expect(sales.locator('#q-details-validUntil')).toHaveValue(ist.toISOString().slice(0, 10));
      await expect(sales.locator('#q-details-validUntil')).toBeEditable();
      // Form reset (React 19): a refusal must leave the chosen trip type on screen, and the next save
      // must post it. Choose international with an impossible adult count: refused; the select keeps it.
      await sales.locator('#q-details-tripScope').selectOption('international');
      await sales.locator('#q-details-adults').fill('101');
      await sales.getByRole('button', { name: 'Save trip and travellers' }).click();
      await expect(sales.locator('section#details')).toContainText('Adults: 0 to 100', { timeout: 30_000 });
      await expect(sales.locator('#q-details-tripScope')).toHaveValue('international');
      // Correct only the count and save again: the stored trip type is the one shown.
      await sales.locator('#q-details-adults').fill('2');
      await sales.getByRole('button', { name: 'Save trip and travellers' }).click();
      await expect(saved(sales, 'details')).toBeVisible({ timeout: 30_000 });
      await expect(sales.locator('#q-details-tripScope')).toHaveValue('international');
      await expect.poll(() => db(async (client) => (await client.query<{ scope: string | null }>('select trip_scope as scope from public.quotation_versions where id = $1', [versionId])).rows[0]?.scope), { timeout: 30_000 }).toBe('international');
      // Back to domestic for the rest of the journey (a second save of the same form, no reload).
      await sales.locator('#q-details-tripScope').selectOption('domestic');
      await sales.getByRole('button', { name: 'Save trip and travellers' }).click();
      await expect.poll(() => db(async (client) => (await client.query<{ scope: string | null }>('select trip_scope as scope from public.quotation_versions where id = $1', [versionId])).rows[0]?.scope), { timeout: 30_000 }).toBe('domestic');
      await expect(sales.locator('#q-details-tripScope')).toHaveValue('domestic');
      // The saved line is still on screen from the save before; the stored value above proves this save.
      await expect(saved(sales, 'details')).toBeVisible({ timeout: 30_000 });

      await openPart(sales, 'contact');
      await sales.locator('#q-contact-contactName').fill('Synthetic Quote Customer');
      await sales.locator('#q-contact-mobile').fill('9876500077');
      await sales.getByRole('button', { name: 'Save contact' }).click();
      await expect(saved(sales, 'contact')).toBeVisible({ timeout: 30_000 });

      await openPart(sales, 'services');
      await sales.locator('#q-services-add-type').selectOption('hotel');
      await sales.getByRole('button', { name: 'Add hotel' }).click();
      const hotel = sales.getByRole('form', { name: 'New hotel service' });
      await hotel.getByLabel('Requested hotel').fill('Synthetic Beach Resort');
      await hotel.getByLabel('City', { exact: true }).fill('Goa');
      await hotel.getByLabel('Check-in').fill(start);
      await hotel.getByLabel('Check-out').fill(end);
      await hotel.getByLabel('Rooms').fill('1');
      await hotel.getByLabel('Adults', { exact: true }).fill('2');
      await hotel.getByRole('button', { name: 'Add this hotel' }).click();
      await expect(sales.locator('section#services')).toContainText('Service 1 · Hotel', { timeout: 30_000 });

      await openPart(sales, 'narrative');
      await sales.locator('#q-day-1-title').fill('Arrival and beach evening');
      await sales.getByRole('button', { name: 'Save day-by-day and terms' }).click();
      await expect(saved(sales, 'narrative')).toBeVisible({ timeout: 30_000 });
    });

    await test.step('prices: option name, a line with our cost (internal zone), the typed total, one "Save prices"; then the payment plan', async () => {
      await openPart(sales, 'money');
      const money = sales.locator('section#money');
      await sales.locator('#q-tier-quoted').fill('Sea view rooms');
      await sales.locator('#q-line-1-lineItemId').selectOption({ label: 'Service 1 · Hotel' });
      await expect(sales.locator('#q-line-1-lineUnitKind')).toHaveValue('room_night');
      await expect(sales.locator('#q-line-1-linePeriods')).toHaveValue('3');
      await sales.locator('#q-line-1-lineUnitSellRupees').fill('10000');
      await sales.locator('#q-line-1-lineUnitCostRupees').fill('8000');
      await expect(money).toContainText('Line: 1 room × 3 nights × ₹10,000 per room per night = ₹30,000');
      await sales.locator('#q-total-quoted').fill('30000');
      await sales.getByLabel('Print the per-person price when it is exact').check();
      // One save for the part: the existing commands in order (options, lines, total), one honest report.
      await expect(money.getByRole('button', { name: 'Save options' })).toHaveCount(0);
      await money.getByRole('button', { name: 'Save prices' }).click();
      await expect(money.getByRole('status').filter({ hasText: 'Saved: Options offered, Price lines, Quoted option total.' })).toBeVisible({ timeout: 30_000 });
      await expect(money).toContainText('Lines add up to (for comparison)', { timeout: 30_000 });
      await expect(money).toContainText('₹30,000');
      await expect(money).toContainText('Printed as: ₹15,000 per person', { timeout: 30_000 });

      await openPart(sales, 'plan');
      const plan = sales.locator('section#plan');
      await plan.getByRole('button', { name: 'Add payment 1' }).click();
      await sales.locator('#q-plan-quoted-1-instalmentLabel').fill('Advance');
      await sales.locator('#q-plan-quoted-1-instalmentAmountRupees').fill('10000');
      await plan.getByRole('button', { name: 'Add payment 2' }).click();
      await sales.locator('#q-plan-quoted-2-instalmentLabel').fill('Balance');
      await sales.locator('#q-plan-quoted-2-instalmentAmountRupees').fill('20000');
      await sales.locator('#q-plan-quoted-2-instalmentDueDays').fill('15');
      await expect(plan).toContainText('equals the quoted total');
      await plan.getByRole('button', { name: 'Save quoted option payment schedule' }).click();
      await expect(saved(sales, 'plan')).toBeVisible({ timeout: 30_000 });
      await sales.screenshot({ path: `${shotDir}/01-editor.png`, fullPage: true });
    });

    await test.step('check and mark ready, customer copy, mark as shared', async () => {
      await sales.reload();
      await sales.getByRole('button', { name: 'Check and mark ready' }).click();
      await expect(sales.locator('main')).toContainText('Quotation status: Ready to share', { timeout: 30_000 });
      // Customer copy is the server-rendered preview (the documents adapter): never our cost.
      await sales.getByRole('navigation', { name: 'Edit or customer copy' }).getByRole('link', { name: 'Customer copy' }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/quotations/${versionId}/preview$`), { timeout: 30_000 });
      await expect(sales.locator('main').getByRole('status')).toContainText('Checked: no internal or pushy words.');
      // One title-only day of a 4-day trip: a staff note in the status, never on the document, never blocking the share.
      await expect(sales.locator('main').getByRole('status')).toContainText('Day plan covers 1 of 4 days.');
      const doc = sales.locator('#quote-document');
      await expect(doc).toContainText('GST as applicable. Quotation — not a tax invoice.');
      await expect(doc).toContainText('₹30,000');
      for (const word of [/cost/i, /margin/i, /supplier/i, /₹8,000/, /₹24,000/]) await expect(doc).not.toContainText(word);
      expect(await sales.content()).not.toContain('₹8,000');
      await sales.screenshot({ path: `${shotDir}/02-preview.png`, fullPage: true });
      await sales.getByRole('navigation', { name: 'Edit or customer copy' }).getByRole('link', { name: 'Edit', exact: true }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/quotations/${versionId}$`), { timeout: 30_000 });
      // QS-01 / J4: "Mark as shared" opens a dialog; the channel is still recorded; the CRM sends nothing.
      await sales.getByRole('button', { name: 'Mark as shared' }).click();
      const dialog = sales.getByRole('dialog', { name: 'Mark version 1 as shared?' });
      await expect(dialog).toContainText('The CRM does not send anything.');
      await dialog.getByLabel('How did you share it?').selectOption('whatsapp');
      // DA-188: one verb for one action; the confirm repeats "Mark as shared".
      await dialog.getByRole('button', { name: 'Mark as shared', exact: true }).click();
      await expect(sales.locator('main')).toContainText('Quotation status: Shared with customer', { timeout: 30_000 });
    });

    await test.step('written acceptance uploaded, version accepted; the page waits for the Bitrix Deal', async () => {
      await sales.locator('#quote-evidence-file').setInputFiles({ name: 'synthetic-acceptance.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic acceptance ${tag}`) });
      await sales.getByRole('button', { name: 'Upload file' }).click();
      await expect(sales.getByRole('list', { name: 'Files of this version' })).toContainText('synthetic-acceptance.pdf', { timeout: 30_000 });
      await expect(sales.getByRole('radio', { name: /Quoted option · Sea view rooms/ })).toBeChecked();
      await sales.getByRole('button', { name: 'Mark accepted' }).click();
      await expect(sales.locator('main')).toContainText('Quotation status: Accepted', { timeout: 30_000 });
      await expect(sales.locator('main')).toContainText('Waiting for the Bitrix deal');
      await sales.screenshot({ path: `${shotDir}/03-accepted-waiting.png`, fullPage: true });
    });

    const dealId = await test.step('Bitrix stand-in: the Deal made from this Lead arrives at Won - Payment Received', async () => bitrixDealFromLead(sourceDealId, sourceLeadId, `Synthetic Goa family trip ${tag}`));

    await test.step('link the arrived Deal, then Start booking from this quotation', async () => {
      await sales.reload();
      await expect(sales.getByRole('radio', { name: new RegExp(`BX-${sourceDealId}`) })).toBeChecked({ timeout: 30_000 });
      await sales.getByRole('button', { name: 'Link this Deal' }).click();
      await expect(sales.locator('main')).toContainText(`Linked to deal BX-${sourceDealId}`, { timeout: 30_000 });
      await sales.getByRole('button', { name: 'Start booking from this quotation' }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 60_000 });
    });

    await test.step('step 1: contact and trip came from the quotation; confirm the contact; passengers with an ID proof each', async () => {
      const main = sales.locator('main');
      await expect(main.getByLabel('Name', { exact: true })).toHaveValue('Synthetic Quote Customer');
      await expect(main.getByLabel('Destination', { exact: true })).toHaveValue('Goa');
      // Book now v2: adult, child and infant steppers (no total box).
      const adults = main.getByRole('spinbutton', { name: 'Adults' });
      if ((await adults.inputValue()) === '') await adults.fill('2');
      const scope = main.getByLabel('Trip', { exact: true });
      if ((await scope.inputValue()) === '') await scope.selectOption('domestic');
      await main.getByLabel(CONTACT_TICK).check();
      // The card saves itself once every check passes (change 2, ruling D1).
      await expect(sales.locator('#pill-customer')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
      await expect.poll(() => db(async (client) => (await client.query<{ c: boolean | null }>(
        `select c.contact_confirmed as c from public.booking_version_contacts c join public.booking_versions v on v.id = c.booking_version_id
         where v.deal_id = $1 and v.status = 'draft'`, [dealId])).rows[0]?.c ?? null), { timeout: 30_000 }).toBe(true);
      // Passenger rows come from the counts (no Add passenger); named rows save themselves.
      await main.getByLabel('Passenger 1 full name').fill('Synthetic Quote Traveller One');
      await main.getByLabel('Passenger 2 full name').fill('Synthetic Quote Traveller Two');
      await expect.poll(() => db(async (client) => (await client.query<{ n: string }>(
        'select count(*)::text as n from public.deal_travellers where deal_id = $1', [dealId])).rows[0]!.n), { timeout: 30_000 }).toBe('2');
      // Each passenger row has a visible "Attach ID proof" button that opens the ID proof dialog; it closes once stored.
      for (const who of ['Synthetic Quote Traveller One', 'Synthetic Quote Traveller Two']) {
        await main.getByRole('button', { name: `Attach ID proof for ${who}` }).click();
        const dialog = sales.getByRole('dialog', { name: `ID proof · ${who}` });
        await dialog.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-id.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic identity proof for ${who} ${tag}`) });
        await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
        await dialog.getByRole('button', { name: `Attach ID proof for ${who}` }).click();
        await expect(dialog).toBeHidden({ timeout: 60_000 });
      }
      await expect(main).not.toContainText('ID proof still needed', { timeout: 30_000 });
      await goToStep(sales, STEP_NAME.stay);
    });

    await test.step('step 2: the hotel came from the quotation; who takes part is chosen here', async () => {
      const main = sales.locator('main');
      await expect(main).toContainText('Synthetic Beach Resort');
      await main.getByRole('button', { name: 'Edit hotel 1' }).click();
      const hotel = sales.getByRole('dialog', { name: 'Edit hotel stay' });
      // Travellers did not exist when the quotation was accepted: who stays is chosen here, by hand (chips).
      const who = hotel.getByRole('group', { name: 'Who stays here' });
      for (const name of ['Synthetic Quote Traveller One', 'Synthetic Quote Traveller Two']) {
        const chip = who.getByRole('button', { name });
        if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
      }
      await expect(hotel.locator('#svc-who-line')).toContainText('2 of 2 chosen');
      await hotel.getByRole('button', { name: 'Save hotel' }).click();
      await expect(hotel).toBeHidden({ timeout: 30_000 });
      await goToStep(sales, STEP_NAME.finish);
    });

    await test.step('step 3: the accepted total stands; Bill To; acceptance from the quotation; submit', async () => {
      const main = sales.locator('main');
      await expect(main.locator('section#price')).toContainText('Total from the accepted quotation: ₹30,000');
      const bill = main.locator('section#billTo');
      // Voice-note batch: Bill To is search first; the typed form opens with "Type the details instead".
      await bill.getByRole('button', { name: 'Type the details instead' }).click();
      await bill.getByRole('button', { name: 'Use booking contact' }).click();
      await bill.getByLabel('Address', { exact: true }).fill('1 Synthetic Lane');
      await bill.getByLabel('City').fill('Jodhpur');
      await bill.getByLabel('State').selectOption('08');
      await bill.getByLabel('PIN code').fill('342001');
      // Bill To saves itself (change 2).
      await expect.poll(() => db(async (client) => (await client.query<{ pin: string | null }>(
        'select postal_code as pin from public.customer_billing_profiles where deal_id = $1', [dealId])).rows[0]?.pin ?? null), { timeout: 30_000 }).toBe('342001');
      // The customer's written OK came from the quotation (its own card, change 9).
      await expect(main.locator('section#ok')).toContainText(/Customer said yes to quotation TQ-\d+, version 1, on /);
      await expect(sales.getByRole('link', { name: 'Open the written OK' })).toBeVisible();
      await expect(sales.locator('#bf-ready').getByRole('heading', { name: 'Ready to submit' })).toBeVisible({ timeout: 30_000 });
      await sales.screenshot({ path: `${shotDir}/04-finish.png`, fullPage: true });
      // Book now v2 (prototype footSubmit): the footer "Review and submit" only scrolls to "Before you submit";
      // the dialog opens from the submit card's own button.
      await main.getByRole('button', { name: 'Review and submit' }).click();
      await expect(sales.locator('#bf-ready')).toBeInViewport();
      await main.getByRole('region', { name: 'Submit' }).getByRole('button', { name: SUBMIT_BUTTON }).click();
      const dialog = sales.getByRole('dialog', { name: SUBMIT_DIALOG });
      await expect(dialog).toContainText('It creates 1 internal task', { timeout: 30_000 });
      await dialog.getByRole('button', { name: SUBMIT_BUTTON }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book$`), { timeout: 60_000 });
      await expect(sales.locator('main')).toContainText('Submitted · accepted version 1');
      await expect(sales.locator('main')).toContainText(/Customer said yes to quotation TQ-\d+, version 1, on /);
    });

    await test.step('one task, the typed total and plan reached the booking; the quotation says booking started', async () => {
      const facts = await db(async (client) => {
        const { rows: tasks } = await client.query<{ n: string }>('select count(*)::text as n from public.fulfilment_tasks where deal_id = $1', [dealId]);
        const { rows: total } = await client.query<{ total: string }>(
          `select c.selling_total_paise::text as total from public.booking_version_commercials c
           join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'confirmed'`,
          [dealId],
        );
        const { rows: plan } = await client.query<{ n: string }>('select count(*)::text as n from public.booking_version_instalments where deal_id = $1', [dealId]);
        return { tasks: tasks[0]!.n, total: total[0]?.total, plan: plan[0]!.n };
      });
      expect(facts).toEqual({ tasks: '1', total: '3000000', plan: '2' });
      await sales.goto(`/app/quotations/${versionId}`);
      await expect(sales.getByRole('link', { name: 'Continue booking' })).toBeVisible();
    });

    const purchase = await runPurchaseUser(tag);
    const purchaseContext = await csp.track(browser, 'purchase');
    const buyer = await signInAndEnrol(purchaseContext, purchase.email);
    await test.step('Purchase: the quotation is "not available" and no quotation price shows', async () => {
      await buyer.goto(`/app/quotations/${versionId}`);
      await expect(buyer.locator('main')).toContainText('This quotation is not available to you. It may not exist, or you may not have access.');
      await expect(buyer.locator('main')).not.toContainText('₹30,000');
      await buyer.goto(`/app/quotations/${versionId}/preview`);
      await expect(buyer.locator('main')).not.toContainText('₹');
      for (const path of [`/app/leads/${leadId}`, `/app/leads/${leadId}?tab=quotations`]) {
        await buyer.goto(path);
        await expect(buyer.getByRole('region', { name: 'Quotations' })).toHaveCount(0);
        await expect(buyer.getByRole('link', { name: 'Quotations' })).toHaveCount(0);
        await expect(buyer.getByRole('link', { name: 'New quotation' })).toHaveCount(0);
        await expect(buyer.locator('main')).not.toContainText('₹');
      }
    });

    // Echo-A L8: Purchase privacy on every Deal tab, on the real stack (not only preview fixtures).
    // The Deal now holds a priced, submitted booking (₹30,000.00 and a two-part plan), a quotation with
    // a stored written acceptance, ID proofs, and a Lead link. Sales is the positive control.
    const FORBIDDEN = [
      '₹',
      '30,000',
      'Selling price',
      'selling total',
      'Final selling total',
      'Deal value',
      'Estimated margin',
      'Payment plan',
      'Reported, not checked',
      'Checked by Accounts',
      'Still to pay',
      'Receipt',
      'Payment proof',
      'payment_proof',
      'synthetic-acceptance.pdf',
      'quotation_acceptance',
      'Came from Lead',
      'From lead',
      'sellingTotal',
      'estimatedMargin',
      'amountPaise',
    ];
    const DEAL_TABS = ['', '?tab=overview', '?tab=services', '?tab=quotations', '?tab=documents', '?tab=money', '?tab=history', '?tab=not-a-tab'];

    await test.step('control: Sales sees the Money tab, the Lead link and the written acceptance in Documents', async () => {
      await sales.goto(`/app/deals/${dealId}`);
      const tabs = sales.getByRole('navigation', { name: 'Deal sections' });
      await expect(tabs.getByRole('link', { name: 'Money' })).toHaveCount(1);
      await expect(sales.locator('main')).toContainText('From lead');
      await sales.goto(`/app/deals/${dealId}?tab=money`);
      await expect(sales.locator('main')).toContainText('₹30,000.00');
      await sales.goto(`/app/deals/${dealId}?tab=documents`);
      await expect(sales.locator('main')).toContainText('synthetic-acceptance.pdf');
    });

    await test.step('Purchase assigned to the Deal: no money, no acceptance or payment files, no Lead link, on every tab and in raw HTML', async () => {
      // SYNTHETIC FIXTURE STEP: no assignment screen exists, so the run's Purchase user is assigned in Postgres.
      const assigned = await db((client) =>
        client.query(
          `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
           select d.id, d.legal_entity_id, $2, 'purchase', $3 from public.deals d where d.id = $1`,
          [dealId, purchase.id, USERS.sales.id],
        ),
      );
      expect(assigned.rowCount, 'synthetic Purchase assignment inserted').toBe(1);
      const reference = await db(async (client) => (await client.query<{ reference: string }>('select reference from public.deals where id = $1', [dealId])).rows[0]!.reference);
      for (const tab of DEAL_TABS) {
        const path = `/app/deals/${dealId}${tab}`;
        await buyer.goto(path);
        const main = buyer.locator('main');
        // Not vacuous: the Deal itself is open to this Purchase user.
        await expect(main, path).toContainText(reference);
        const tabsNav = buyer.getByRole('navigation', { name: 'Deal sections' });
        await expect(tabsNav.getByRole('link', { name: 'Overview' }), path).toHaveCount(1);
        await expect(tabsNav.getByRole('link', { name: 'Money' }), path).toHaveCount(0);
        await expect(tabsNav.getByRole('link', { name: 'Quotations' }), path).toHaveCount(0);
        const html = await (await buyer.request.get(path)).text();
        for (const hidden of FORBIDDEN) {
          await expect(main, `${path}: ${hidden}`).not.toContainText(hidden);
          expect(html, `${path} raw HTML: ${hidden}`).not.toContain(hidden);
        }
      }
      // Money and unknown tabs fall back to Overview for Purchase; Documents opens and lists no
      // customer acceptance, booking acceptance or payment-proof file.
      for (const tab of ['?tab=money', '?tab=not-a-tab', '?tab=quotations']) {
        await buyer.goto(`/app/deals/${dealId}${tab}`);
        await expect(buyer.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
      }
      await buyer.goto(`/app/deals/${dealId}?tab=documents`);
      const documents = buyer.locator('main');
      await expect(buyer.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
      for (const hidden of ['Customer’s acceptance message', 'Acceptance file', 'Payment proof', 'Booking version', 'Booking file']) {
        await expect(documents, `documents: ${hidden}`).not.toContainText(hidden);
      }
      await buyer.screenshot({ path: `${shotDir}/purchase-deal-documents.png`, fullPage: true });
    });

    expect(csp.violations).toEqual([]);
    await Promise.all([salesContext.close(), purchaseContext.close()]);
  });
});
