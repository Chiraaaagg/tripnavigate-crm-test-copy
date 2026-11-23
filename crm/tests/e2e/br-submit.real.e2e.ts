import { expect, test } from '@playwright/test';
import { enrolTotpViaUi, istToday, signInViaUi } from '../helpers/browser-journey';
import {
  addHotel,
  attachProof,
  configured,
  db,
  fillCustomer,
  footerSettled,
  gotoStep,
  loadFixture,
  nameRow,
  newDeal,
  pageErrors,
  pillIs,
  Recorder,
  requestedBrFile,
  restoreSwitch,
  newSalesContext,
  saveActiveRecorder,
  sleep,
  startBooking,
  SUBMIT_BUTTON,
  SUBMIT_DIALOG,
  syntheticPdf,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1: the journey to a STORED Submit, as
 * assertions (build contract section 8, PR-C row: "the journey to a stored
 * Submit; one Accounts-side check that the submitted booking appears in the
 * Accounts queue (BR-37)"). REAL local Supabase stack, production build. The
 * local real-Deal booking gate and the service-items switch are opened for the
 * run in the disposable database (as the investigation run did; production
 * has both on) and restored afterwards.
 *
 * One Sales booking on a Bitrix-style Deal at "Won - Payment Received": two
 * adults with ID proofs, one hotel, package price, Bill To from the booking
 * contact, a payment plan equal to the total, acceptance evidence, Submit once.
 * Then asserted:
 *   - the screen shows Submitted; one confirmed version, no draft left;
 *   - fulfilment tasks were created for the hotel;
 *   - an Accounts booking review exists for the confirmed version (pending);
 *   - an Accounts user sees the Deal in "To check" (/app/accounts) (BR-37);
 *   - no page errors during the journey (B1-2).
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it.
 */

const FILE = 'br-submit.real.e2e.ts';
const requested = requestedBrFile(FILE);
const ACCOUNTS = { id: 'a0000000-0000-4000-8000-000000000101', email: 'accounts.fin.a@example.test' } as const;

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

test.describe('Fix batch 1: journey to a stored Submit and the Accounts queue @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(saveActiveRecorder);
  test.afterAll(async () => {
    if (requested) await restoreSwitch(FILE);
  });

  test('Sales books from Deal to a stored Submit; tasks and the Accounts review exist; Accounts sees the Deal @br', async ({ browser }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const rec = new Recorder('br-submit', testInfo);
    await loadFixture(testInfo);
    const tag = String(Date.now()).slice(-8);
    const deal = await newDeal(tag, `Synthetic submit journey ${tag}`);
    rec.facts.deal = deal;
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const names = ['Synthetic Submit Adult One', 'Synthetic Submit Adult Two'];

    await test.step('step 1: customer, passengers, ID proofs', async () => {
      await startBookingAndFill();
      for (const [i, n] of names.entries()) await nameRow(rec, page, i + 1, n, deal.id, i + 1);
      await footerSettled(page);
      for (const [i, n] of names.entries()) await attachProof(rec, page, n, `submit${i + 1}`, false);
      await footerSettled(page);
    });

    async function startBookingAndFill() {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '2', children: '0', infants: '0' });
      await footerSettled(page);
    }

    await test.step('step 2: one hotel', async () => {
      await addHotel(page, 'Synthetic Submit Hotel', '9000');
      await expect(main).toContainText('Synthetic Submit Hotel', { timeout: 30_000 });
      await footerSettled(page);
    });

    let totalRupees = 0;
    await test.step('step 3: price, Bill To, payment plan, acceptance', async () => {
      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 2 → step 3');
      const price = main.locator('section#price');
      await price.getByLabel('Adult purchase per person, rupees').fill('20000');
      await price.getByLabel('Adult markup per person, rupees').fill('2000');
      await pillIs(page, 'pill-price', /^saved$/, 30_000);
      const paise = await db(async (c) => (await c.query<{ t: string | null }>(`select c.selling_total_paise::text as t from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'draft'`, [deal.id])).rows[0]?.t ?? null);
      totalRupees = paise ? Number(paise) / 100 : 0;
      expect(totalRupees, 'selling total stored').toBeGreaterThan(0);

      const bill = main.locator('section#billTo');
      await bill.getByRole('button', { name: 'Type the details instead' }).click();
      await bill.getByRole('button', { name: 'Use booking contact' }).click();
      await bill.getByLabel('Address', { exact: true }).pressSequentially('1 Synthetic Lane', { delay: 15 });
      await bill.getByLabel('City').fill('Jodhpur');
      await bill.getByLabel('State').selectOption('08');
      await bill.getByLabel('PIN code').fill('342001');
      await pillIs(page, 'pill-billTo', /^saved$/, 30_000);

      const plan = main.locator('section#plan');
      await plan.getByRole('button', { name: 'Add instalment' }).click();
      await plan.getByLabel('Instalment 1', { exact: true }).fill('Full payment');
      await plan.locator('#payment-1-amount').fill(String(totalRupees));
      await plan.locator('#payment-1-due').fill(istToday());
      await pillIs(page, 'pill-plan', /^saved$/, 30_000);

      await page.getByLabel('Acceptance file').setInputFiles({ name: 'synthetic-acceptance.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic acceptance ${tag}`) });
      await expect(page.locator('section#ok')).toContainText('synthetic-acceptance.pdf', { timeout: 30_000 });
      await footerSettled(page);
      rec.facts.readyBeforeSubmit = ((await page.locator('#bf-ready').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 600);
    });

    await test.step('Submit once → Submitted', async () => {
      await main.getByRole('button', { name: 'Review and submit' }).click();
      const trigger = main.getByRole('region', { name: 'Submit' }).getByRole('button', { name: SUBMIT_BUTTON });
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      await expect(trigger, `Submit available (readiness: ${String(rec.facts.readyBeforeSubmit)})`).toBeEnabled();
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: SUBMIT_DIALOG });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await dialog.getByRole('button', { name: SUBMIT_BUTTON }).click();
      await expect(page).toHaveURL(new RegExp(`/app/deals/${deal.id}/book$`), { timeout: 30_000 });
      await expect(main).toContainText(/Submitted/, { timeout: 30_000 });
    });

    await test.step('stored: one confirmed version, tasks, the Accounts review', async () => {
      const versions = await db(async (c) => (await c.query<{ status: string; n: number }>('select status, count(*)::int as n from public.booking_versions where deal_id = $1 group by status', [deal.id])).rows);
      rec.facts.versions = versions;
      expect(versions.find((v) => v.status === 'confirmed')?.n, 'one confirmed version').toBe(1);
      expect(versions.find((v) => v.status === 'draft'), 'no draft left').toBeUndefined();
      const tasks = await db(async (c) => Number((await c.query<{ n: string }>(
        `select count(*)::text as n from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
          where t.deal_id = $1 and i.service_type = 'hotel'`, [deal.id])).rows[0]!.n));
      expect(tasks, 'fulfilment task(s) for the hotel').toBeGreaterThan(0);
      const reviews = await db(async (c) => (await c.query<{ status: string; confirmed: boolean }>(
        `select r.status, (v.status = 'confirmed') as confirmed from public.accounts_booking_reviews r
           join public.booking_versions v on v.id = r.booking_version_id where r.deal_id = $1`, [deal.id])).rows);
      rec.facts.accountsReviews = reviews;
      expect(reviews.filter((r) => r.confirmed && r.status === 'pending'), 'an Accounts booking review (pending) for the confirmed version').toHaveLength(1);
      await page.reload();
      await expect(main).toContainText(/Submitted/, { timeout: 30_000 });
    });
    const salesPageErrors = pageErrors(rec);
    await context.close();

    await test.step('BR-37: an Accounts user sees the Deal in "To check"', async () => {
      const reference = await db(async (c) => (await c.query<{ r: string }>('select reference as r from public.deals where id = $1', [deal.id])).rows[0]!.r);
      await db(async (c) => {
        await c.query('delete from auth.mfa_factors where user_id = $1', [ACCOUNTS.id]);
      });
      const accContext = await browser.newContext();
      const acc = await accContext.newPage();
      rec.attach(acc, 'accounts');
      await signInViaUi(acc, ACCOUNTS.email, process.env.LOCAL_FIXTURE_PASSWORD!);
      await enrolTotpViaUi(acc);
      await expect(acc).toHaveURL(/\/app$/, { timeout: 30_000 });
      await acc.goto('/app/accounts');
      const queue = acc.locator('main');
      await expect(queue.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
      await sleep(1_000);
      const inQueue = (await queue.getByRole('link', { name: new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).count()) > 0;
      rec.facts.accountsQueue = { reference, inQueue, text: ((await queue.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 800) };
      await rec.shot(acc, 'accounts-to-check');
      expect(inQueue, `Deal ${reference} listed in the Accounts "To check" queue (default filter: Booking reviews)`).toBe(true);
      await accContext.close();
    });

    await rec.save();
    expect(salesPageErrors, 'no page errors during the Sales journey (B1-2)').toEqual([]);
  });
});
