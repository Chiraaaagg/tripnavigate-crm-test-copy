import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { cspRecorder, enrolTotpViaUi, istToday, signInViaUi, withDb } from '../helpers/browser-journey';
import { isLoopbackDatabaseUrl, isLoopbackUrl } from '../helpers/test-env.mjs';

/**
 * Direction A Batch 3 browser journey: a referral draft (a customer not in
 * Bitrix yet) from the sidebar to a booking, against a REAL local Supabase
 * stack served by the production build (playwright.real.config.ts, project
 * real-journey). The lead runs it at the gate; never against a hosted database.
 *
 * Sales opens Quotations → New quotation → Referral (no Bitrix record yet),
 * types only the customer's name, a mobile and a title, and lands in the
 * editor of the new quotation (TD-n draft, TQ-n quotation). Sales fills the
 * trip, a hotel and the price, marks it ready and shared, uploads the
 * written acceptance and marks it accepted. Booking waits: the quotation says
 * to link the draft to the confirmed Bitrix Deal. A Bitrix stand-in (SQL only)
 * stores a Won Deal in the same branch; Sales links the draft to it on the
 * draft page (pick, confirm; nothing preselected), then presses "Start
 * booking from this quotation" (bind to the draft's Deal, then convert).
 *
 * Then: with the switch off, a new referral draft is not offered, while the
 * existing draft still saves; a second draft closed by hand is hidden from the
 * normal list, shows under "Closed drafts" and opens by its TD-n reference
 * with Reopen. A Purchase user reaches none of it.
 *
 * Fixture steps (synthetic, local only, audited reasons): the synthetic
 * entity and users of the Accounts journey, one run Purchase user, the
 * referral_drafts and service_items_enabled switches and the local real-Deal
 * booking gate for the run (all restored afterwards), the Deal header as the
 * Bitrix sync would store it.
 *
 * Skips without a real stack; fails (never skips) when REQUIRE_REAL_STACK=1.
 */

const fixturePassword = process.env.LOCAL_FIXTURE_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const configured = Boolean(fixturePassword && databaseUrl && supabaseUrl && secretKey);

if (process.env.REQUIRE_REAL_STACK === '1' && !configured) {
  throw new Error('REQUIRE_REAL_STACK=1 but LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, the Supabase URL or the secret key is missing: the Batch 3 referral journey must run, not skip.');
}
if (configured && (!isLoopbackUrl(supabaseUrl) || !isLoopbackDatabaseUrl(databaseUrl))) {
  throw new Error('The Batch 3 referral journey runs only against a loopback Supabase stack and database.');
}

const ENTITY_ID = 'e0000000-0000-4000-8000-0000000000f0';
const ENTITY_CODE = 'SYNTHETIC_FIN';
const BRANCH_CODE = 'FBR';
const PORTAL = 'SYNTHETIC_MEMBER_0001';
const USERS = {
  a: { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test', name: 'Synthetic Accounts Finance A' },
  b: { id: 'a0000000-0000-4000-8000-000000000102', email: 'accounts.fin.b@example.test', name: 'Synthetic Accounts Finance B' },
  sales: { id: 'a0000000-0000-4000-8000-000000000103', email: 'sales.fin@example.test', name: 'Synthetic Sales Finance' },
} as const;
const shotDir = 'test-results/real-journey/b3-referral';
const noPersist = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;
const db = <T>(fn: Parameters<typeof withDb<T>>[1]) => withDb(databaseUrl!, fn);

let saved: { referral: boolean; items: boolean; realBooking: boolean } | null = null;

/** Audited switch change for the run (the settings trigger records the reason). */
async function setSwitches(values: { referral?: boolean; items?: boolean; realBooking?: boolean }, reason: string) {
  await db(async (client) => {
    await client.query(`select set_config('tripnavigate.change_reason', $1, false)`, [`b3-referral.real.e2e.ts: ${reason}`]);
    if (values.referral !== undefined) await client.query('update public.workflow_settings set referral_drafts = $1 where id', [values.referral]);
    if (values.items !== undefined) await client.query('update public.workflow_settings set service_items_enabled = $1 where id', [values.items]);
    if (values.realBooking !== undefined) await client.query('update public.booking_settings set real_booking_enabled = $1 where id', [values.realBooking]);
  });
}

async function loadFixture(fixtureFile: string) {
  await db(async (client) => {
    const { rows } = await client.query<{ environment: string }>('select environment from public.deployment_settings where id');
    expect(rows[0]?.environment, "the Batch 3 journey needs the 'test' deployment environment").toBe('test');
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
    const { rows: w } = await client.query<{ referral: boolean; items: boolean }>('select referral_drafts as referral, service_items_enabled as items from public.workflow_settings where id');
    const { rows: b } = await client.query<{ on: boolean }>('select real_booking_enabled as "on" from public.booking_settings where id');
    saved = { referral: w[0]!.referral, items: w[0]!.items, realBooking: b[0]!.on };
  });
  await setSwitches({ referral: true, items: true, realBooking: true }, 'referral drafts, service items and the local real-Deal gate on for the run');
}

async function runPurchaseUser(tag: string): Promise<{ id: string; email: string }> {
  const email = `b3-referral.purchase.${tag}@example.test`;
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

/** Bitrix stand-in: a Won Deal in the draft's branch, as the sync stores it (no Lead behind it). */
async function bitrixWonDeal(sourceDealId: number, title: string): Promise<string> {
  const admin = createClient(supabaseUrl!, secretKey!, { auth: noPersist });
  const recorded = await admin.rpc('integration_record_bitrix_event', { p_member_id: PORTAL, p_event_type: 'ONCRMDEALADD', p_deal_id: sourceDealId, p_source_ts: Math.floor(Date.now() / 1000) });
  if (recorded.error) throw new Error(`inbox ONCRMDEALADD: ${recorded.error.message}`);
  const inboxId = (recorded.data as { inboxId: string }).inboxId;
  return db(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
         source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at, source_modified_at,
         last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id)
       select b.legal_entity_id, b.id, 'BX-' || $1::bigint, $2, $3, false,
         'bitrix', $4, $1, 'UC_AD0SLH', 0, now(), now(), now(), now(), $5, 9001
       from public.branches b where b.legal_entity_id = $6 and b.code = $7 returning id`,
      [sourceDealId, title, USERS.sales.id, PORTAL, inboxId, ENTITY_ID, BRANCH_CODE],
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

type PartKey = 'details' | 'contact' | 'services' | 'narrative' | 'money' | 'plan';
const openPart = async (page: Page, part: PartKey) => {
  const toggle = page.locator(`button[aria-controls="${part}-body"]`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
};
const syntheticPdf = (label: string) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`);
const savedPart = (page: Page, section: string) => page.locator(`section#${section}`).getByRole('status').filter({ hasText: 'Saved. Nothing has been sent or booked.' });

/** Quotations → New quotation → the referral form (only the name is required). Returns the new version id. */
async function createReferralQuotation(page: Page, input: { name: string; mobile?: string; title: string }): Promise<string> {
  await page.goto('/app/quotations');
  await page.getByRole('link', { name: 'New quotation' }).click();
  await expect(page).toHaveURL(/\/app\/quotations\/new$/, { timeout: 30_000 });
  const form = page.getByRole('form', { name: 'New referral quotation' });
  await form.getByLabel('Customer name').fill(input.name);
  if (input.mobile) await form.getByLabel(/^Mobile/).fill(input.mobile);
  await form.getByLabel(/^Title/).fill(input.title);
  await form.getByRole('button', { name: 'Create referral quotation' }).click();
  await expect(page).toHaveURL(/\/app\/quotations\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return page.url().split('/').pop()!;
}

const draftOf = (versionId: string) =>
  db(async (client) => {
    const { rows } = await client.query<{ draft_id: string; reference: string }>(
      `select d.id as draft_id, d.reference from public.quotation_versions v
       join public.quotations q on q.id = v.quotation_id join public.referral_drafts d on d.id = q.referral_draft_id where v.id = $1`,
      [versionId],
    );
    expect(rows, 'the quotation belongs to a referral draft').toHaveLength(1);
    return { draftId: rows[0]!.draft_id, reference: rows[0]!.reference };
  });

test.describe('Batch 3 referral draft journey (real local stack)', () => {
  test.skip(!configured, 'Real local Supabase stack not configured (LOCAL_FIXTURE_PASSWORD, TEST_DATABASE_URL, Supabase URL and secret key).');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    if (!configured || !saved) return;
    await setSwitches(saved, 'restore the switches after the run');
  });

  test('referral quotation without Bitrix → accepted → draft linked to the Won Deal → booking started; switch off; closed hidden but openable; Purchase sees nothing', async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    mkdirSync(shotDir, { recursive: true });
    const tag = String(Date.now()).slice(-8);
    const csp = cspRecorder();
    const sourceDealId = 710_000_000 + Number(tag.slice(-6)) * 10;
    const start = istToday(30);
    const end = istToday(33);
    const fixtureFile = join(testInfo.project.testDir, '..', '..', 'supabase', 'fixtures', 'journeys', 'accounts_journey.sql');

    await test.step('fixture: synthetic entity and users; referral drafts on for the run (audited reason)', async () => loadFixture(fixtureFile));

    const salesContext = await csp.track(browser, 'sales');
    const sales = await signInAndEnrol(salesContext, USERS.sales.email);

    await test.step('sidebar: Quotations and Itineraries for Sales', async () => {
      const nav = sales.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Quotations' })).toHaveAttribute('href', '/app/quotations');
      await expect(nav.getByRole('link', { name: 'Itineraries' })).toHaveAttribute('href', '/app/itineraries');
    });

    const versionId = await test.step('New quotation → Referral (no Bitrix record yet): name, mobile, title → the editor', async () =>
      createReferralQuotation(sales, { name: `Synthetic Referral Customer ${tag}`, mobile: '98765 11102', title: `Kerala for the synthetic couple ${tag}` }),
    );
    const draft = await draftOf(versionId);
    await expect(sales.locator('main')).toContainText(`Referral draft ${draft.reference}`);
    // The referral form already saved the customer's details, so the quotation is a started draft (not "Not started").
    await expect(sales.locator('main')).toContainText('Quotation status: Draft');
    await expect(sales.locator('main')).toContainText('2. CustomerSaved');

    await test.step('editor: trip, travellers, a hotel, the option name, a priced line and the total', async () => {
      await openPart(sales, 'details');
      await sales.locator('#q-details-destination').fill('Kerala');
      await sales.locator('#q-details-tripScope').selectOption('domestic');
      await sales.locator('#q-details-tripStart').fill(start);
      await sales.locator('#q-details-tripEnd').fill(end);
      await sales.locator('#q-details-adults').fill('2');
      await sales.getByRole('button', { name: 'Save trip and travellers' }).click();
      await expect(savedPart(sales, 'details')).toBeVisible({ timeout: 30_000 });

      await openPart(sales, 'services');
      await sales.locator('#q-services-add-type').selectOption('hotel');
      await sales.getByRole('button', { name: 'Add hotel' }).click();
      const hotel = sales.getByRole('form', { name: 'New hotel service' });
      await hotel.getByLabel('Requested hotel').fill('Synthetic Backwater Resort');
      await hotel.getByLabel('City', { exact: true }).fill('Alleppey');
      await hotel.getByLabel('Check-in').fill(start);
      await hotel.getByLabel('Check-out').fill(end);
      await hotel.getByLabel('Rooms').fill('1');
      await hotel.getByLabel('Adults', { exact: true }).fill('2');
      await hotel.getByRole('button', { name: 'Add this hotel' }).click();
      await expect(sales.locator('section#services')).toContainText('Service 1 · Hotel', { timeout: 30_000 });

      await openPart(sales, 'money');
      const money = sales.locator('section#money');
      await sales.locator('#q-tier-quoted').fill('Lake view room');
      await sales.locator('#q-line-1-lineItemId').selectOption({ label: 'Service 1 · Hotel' });
      await sales.locator('#q-line-1-lineUnitSellRupees').fill('12000');
      await sales.locator('#q-total-quoted').fill('36000');
      await money.getByRole('button', { name: 'Save prices' }).click();
      await expect(money.getByRole('status').filter({ hasText: /^Saved:/ })).toBeVisible({ timeout: 30_000 });
    });

    await test.step('check and mark ready, mark as shared, written acceptance, accepted; booking waits for the deal link', async () => {
      await sales.reload();
      await sales.getByRole('button', { name: 'Check and mark ready' }).click();
      await expect(sales.locator('main')).toContainText('Quotation status: Ready to share', { timeout: 30_000 });
      await sales.getByRole('button', { name: 'Mark as shared' }).click();
      const dialog = sales.getByRole('dialog', { name: 'Mark version 1 as shared?' });
      await dialog.getByLabel('How did you share it?').selectOption('whatsapp');
      await dialog.getByRole('button', { name: 'Mark as shared', exact: true }).click();
      await expect(sales.locator('main')).toContainText('Quotation status: Shared with customer', { timeout: 30_000 });
      await sales.locator('#quote-evidence-file').setInputFiles({ name: 'synthetic-acceptance.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic acceptance ${tag}`) });
      await sales.getByRole('button', { name: 'Upload file' }).click();
      await expect(sales.getByRole('list', { name: 'Files of this version' })).toContainText('synthetic-acceptance.pdf', { timeout: 30_000 });
      await sales.getByRole('button', { name: 'Mark accepted' }).click();
      await expect(sales.locator('main')).toContainText('Quotation status: Accepted', { timeout: 30_000 });
      await expect(sales.locator('main')).toContainText('Next: link the referral draft to the confirmed Bitrix deal');
      await expect(sales.getByRole('button', { name: 'Start booking from this quotation' })).toHaveCount(0);
      // DA-232: step 1 is the draft's link, opened from the quotation.
      await expect(sales.getByRole('link', { name: 'Link to Bitrix deal' })).toHaveAttribute('href', `/app/quotations/drafts/${draft.draftId}?tab=link`);
      await sales.screenshot({ path: `${shotDir}/01-accepted-waiting.png`, fullPage: true });
    });

    const dealId = await test.step('Bitrix stand-in: a Won Deal arrives in the same branch', async () => bitrixWonDeal(sourceDealId, `Synthetic Kerala couple ${tag}`));

    await test.step('draft page: Link to Bitrix → pick the deal (nothing preselected) → confirm → linked; nothing changed in Bitrix', async () => {
      await sales.goto(`/app/quotations/drafts/${draft.draftId}?tab=link&kind=deal&query=BX-${sourceDealId}`);
      const form = sales.getByRole('form', { name: 'Link to a Bitrix deal' });
      const choice = form.getByRole('radio', { name: new RegExp(`BX-${sourceDealId}`) });
      await expect(choice).not.toBeChecked();
      await choice.check();
      await form.getByRole('button', { name: `Link to BX-${sourceDealId}` }).click();
      const dialog = sales.getByRole('dialog', { name: `Link this draft to BX-${sourceDealId}?` });
      await expect(dialog).toContainText('Nothing changes in Bitrix.');
      await dialog.getByRole('button', { name: 'Link', exact: true }).click();
      // Echo-B H1(a) / M1: the result line (DA-64) sits above the tabs, outside the form the new link replaces;
      // the links card lists the active link.
      await expect(sales.locator('main')).toContainText(`Linked to BX-${sourceDealId}. Nothing changed in Bitrix.`, { timeout: 30_000 });
      await expect(sales.locator('main').locator('[data-slot="referral-link"]').filter({ hasText: `Active link: Deal BX-${sourceDealId}` })).toHaveCount(1);
    });

    await test.step('Deal page: "Referral drafts for this deal" lists the draft', async () => {
      await sales.goto(`/app/deals/${dealId}?tab=quotations`);
      // Echo-B H1(b): the section region carries the heading name (the table itself has none).
      await expect(sales.getByRole('region', { name: 'Referral drafts for this deal' })).toContainText(draft.reference, { timeout: 30_000 });
    });

    await test.step('quotation: Start booking from this quotation binds to the linked deal, then opens the booking', async () => {
      // Echo M4: the draft's primary says what it does and opens the accepted quotation.
      await sales.goto(`/app/quotations/drafts/${draft.draftId}`);
      await sales.getByRole('link', { name: /^Open TQ-\d+ to start booking$/ }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/quotations/${versionId}$`), { timeout: 30_000 });
      await sales.getByRole('button', { name: 'Start booking from this quotation' }).click();
      await expect(sales).toHaveURL(new RegExp(`/app/deals/${dealId}/book/travellers`), { timeout: 60_000 });
      const bound = await db(async (client) => {
        const { rows } = await client.query<{ linked: string | null; converted: boolean }>(
          `select q.linked_deal_id::text as linked, q.converted_at is not null as converted from public.quotation_versions v join public.quotations q on q.id = v.quotation_id where v.id = $1`,
          [versionId],
        );
        return rows[0]!;
      });
      expect(bound).toEqual({ linked: dealId, converted: true });
    });

    await test.step('switch off: no new referral draft is offered; the existing draft still saves', async () => {
      await setSwitches({ referral: false }, 'referral drafts off to check the switch-off states');
      await sales.goto('/app/quotations/new');
      await expect(sales.locator('main')).toContainText('Referral drafts are switched off, so you cannot start a new one. Existing drafts keep working.');
      await expect(sales.getByRole('button', { name: 'Create referral quotation' })).toHaveCount(0);
      await sales.goto(`/app/quotations/drafts/${draft.draftId}`);
      // Echo-B H1(c): "Edit customer details" is a <summary> (no implicit role in Playwright).
      await sales.locator('summary', { hasText: 'Edit customer details' }).click();
      const edit = sales.getByRole('form', { name: 'Edit customer details' });
      await edit.getByLabel(/^Company/).fill('Synthetic Couple Travels');
      await edit.getByRole('button', { name: 'Save customer details' }).click();
      await expect(sales.locator('main')).toContainText('Customer details saved.', { timeout: 30_000 });
      // The saved value is on the Overview after the refresh (the existing draft keeps working while the switch is off, DEC-54).
      await sales.reload();
      await expect(sales.locator('main')).toContainText('Synthetic Couple Travels');
      await setSwitches({ referral: true }, 'referral drafts on again for the closed-draft check');
    });

    const closed = await test.step('a second draft, closed by hand as a duplicate', async () => {
      const second = await createReferralQuotation(sales, { name: `Synthetic Duplicate Customer ${tag}`, title: `Duplicate enquiry ${tag}` });
      const d = await draftOf(second);
      const quote = await db(async (client) => (await client.query<{ reference: string }>('select q.reference from public.quotation_versions v join public.quotations q on q.id = v.quotation_id where v.id = $1', [second])).rows[0]!.reference);
      await sales.goto(`/app/quotations/drafts/${d.draftId}`);
      await sales.getByRole('button', { name: 'Close draft' }).first().click();
      const form = sales.getByRole('form', { name: 'Close draft' });
      await form.getByLabel('Duplicate').check();
      await form.getByRole('button', { name: 'Close draft' }).click();
      // Echo-B H1(d): the answer is the page-level result line (outside the dialog, survives the refresh); the page says it is closed.
      await expect(sales.locator('[data-slot="draft-result"]')).toContainText('Draft closed. Closed drafts stay readable and can be reopened.', { timeout: 30_000 });
      await expect(sales.locator('main')).toContainText('This draft is closed. Reopen it to make changes.');
      await expect(sales.getByRole('button', { name: 'Reopen draft' }).first()).toBeVisible();
      return { ...d, quote };
    });

    await test.step('closed and never linked: hidden from the list, shown under Closed drafts, opens by its reference with Reopen', async () => {
      await sales.goto('/app/quotations?scope=all');
      await expect(sales.locator('main')).not.toContainText(closed.quote);
      await expect(sales.locator('main')).toContainText('Closed drafts that were never linked are not in this list. Choose “Closed drafts” or open one by its reference.');
      await sales.goto('/app/quotations?filter=closed_drafts&scope=all');
      await expect(sales.locator('main')).toContainText(closed.quote);
      await sales.goto(`/app/quotations?reference=${closed.reference}`);
      await expect(sales).toHaveURL(new RegExp(`/app/quotations/drafts/${closed.draftId}$`), { timeout: 30_000 });
      await expect(sales.getByRole('button', { name: 'Reopen draft' }).first()).toBeVisible();
      await sales.screenshot({ path: `${shotDir}/02-closed-draft.png`, fullPage: true });
    });

    const purchase = await runPurchaseUser(tag);
    const purchaseContext = await csp.track(browser, 'purchase');
    const buyer = await signInAndEnrol(purchaseContext, purchase.email);
    await test.step('Purchase: no menu item, no rows, the draft and the quotation are not available', async () => {
      const nav = buyer.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Quotations' })).toHaveCount(0);
      await expect(nav.getByRole('link', { name: 'Itineraries' })).toHaveCount(0);
      await buyer.goto('/app/quotations');
      await expect(buyer.locator('main')).not.toContainText(draft.reference);
      await buyer.goto(`/app/quotations/drafts/${draft.draftId}`);
      await expect(buyer.locator('main')).toContainText('This referral draft is not available.');
      await buyer.goto(`/app/quotations/${versionId}`);
      await expect(buyer.locator('main')).toContainText('This quotation is not available to you.');
      await expect(buyer.locator('main')).not.toContainText('₹');
    });

    expect(csp.violations, 'no CSP violations on the referral screens').toEqual([]);
  });
});
