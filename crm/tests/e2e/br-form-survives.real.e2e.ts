import { expect, test } from '@playwright/test';
import { BOOK_RELIABILITY_TEXT as W } from '../../src/modules/fulfilment/contracts';
import {
  configured,
  db,
  fillCustomer,
  footerSettled,
  gotoStep,
  installFault,
  loadFixture,
  nameRow,
  newDeal,
  newSalesContext,
  pillIs,
  Recorder,
  requestedBrFile,
  restoreFaults,
  restoreSwitch,
  saveActiveRecorder,
  sleep,
  startBooking,
  storedDestination,
  SUBMIT_BUTTON,
  until,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1, item B1-3 (BR-05, BR-06): Book now survives
 * a failed optional panel and a failed re-read. REAL local Supabase stack,
 * production build. Faults are a TEST-ONLY switch in the disposable database
 * (installFault: the named function raises SQLSTATE 57014), never in product
 * code (contract section 11, S7). Asserts the FIXED behaviour of contract
 * section 6 B1-3, so it fails on main and passes once slices S4 and S3 are
 * merged:
 *
 *   A. Optional readers fail (payment claims and the checklist) on the re-read
 *      after a save: the form stays, an open drawer keeps its unsaved entry,
 *      W3 shows in place of the claims, W3b in place of the checklist, and
 *      Submit is not available.
 *   B. The required read (booking_form_get) fails on the re-read after a save
 *      that succeeded: the form stays with the typing, W2 and "Refresh again"
 *      show; "Refresh again" recovers once the read works.
 *   C. The same failure on a first load: the "Booking did not load" page with
 *      W4 (no "Nothing was changed").
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it.
 */

const FILE = 'br-form-survives.real.e2e.ts';
const requested = requestedBrFile(FILE);

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

async function sellingTotal(dealId: string): Promise<string | null> {
  return db(async (c) => (await c.query<{ t: string | null }>(
    `select c.selling_total_paise::text as t from public.booking_version_commercials c
       join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'draft'`, [dealId])).rows[0]?.t ?? null);
}

test.describe('B1-3: Book now survives failed reads (fix batch 1) @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(async () => {
    await restoreFaults();
    await saveActiveRecorder();
  });
  test.afterAll(async () => {
    if (requested) {
      await restoreFaults();
      await restoreSwitch(FILE);
    }
  });

  test('optional parts fail, then the re-read fails, then a first load fails @br', async ({ browser }, testInfo) => {
    test.setTimeout(8 * 60_000);
    const rec = new Recorder('br-form-survives', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic form survives');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await startBooking(rec, page, deal.id);
    await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
    await nameRow(rec, page, 1, 'Synthetic Survive Adult', deal.id, 1);
    await footerSettled(page);
    await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 1 → step 3');
    const price = main.locator('section#price');
    await price.getByLabel('Adult purchase per person, rupees').fill('20000');
    await price.getByLabel('Adult markup per person, rupees').fill('2000');
    await pillIs(page, 'pill-price', /^saved$/, 30_000);
    await footerSettled(page);
    await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'step 3 → step 1');

    await test.step('A. optional readers fail on the re-read: form and unsaved drawer entry survive; W3, W3b; Submit not available', async () => {
      await installFault('deal_payment_claims');
      await installFault('intake_checklist');
      const dest = main.getByLabel('Destination', { exact: true });
      await dest.fill('Jodhpur with failed panels');
      // The drawer is opened while the autosave and its re-read run.
      await main.getByRole('button', { name: 'Details for passenger 1' }).click();
      const drawer = page.getByRole('dialog', { name: 'Passenger details' });
      await expect(drawer).toBeVisible({ timeout: 30_000 });
      await drawer.getByLabel('Other requirements').fill('Synthetic unsaved drawer note');
      await until(async () => (await storedDestination(deal.id)) === 'Jodhpur with failed panels', 30_000, 'destination stored');
      await sleep(4_000); // the save's re-read has come back (with the failed parts)
      await expect(drawer, 'the open drawer survives the re-read').toBeVisible();
      await expect(drawer.getByLabel('Other requirements'), 'its unsaved entry is kept').toHaveValue('Synthetic unsaved drawer note');
      await expect(page.getByText(W.bookingDidNotLoad)).toHaveCount(0);
      await expect(page.getByText('Nothing was changed')).toHaveCount(0);
      await drawer.getByLabel('Other requirements').fill('');
      await drawer.getByRole('button', { name: 'Cancel' }).first().click();
      await expect(drawer).toBeHidden({ timeout: 10_000 });
      await expect(dest).toHaveValue('Jodhpur with failed panels');

      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 1 → step 3 with failed parts');
      await expect(main.getByText(W.partNotLoaded.claims).first(), 'W3 in place of the payment claims').toBeVisible({ timeout: 20_000 });
      await expect(main.getByText(W.partNotLoadedTail).first()).toBeVisible();
      await expect(main.getByText(W.checklistNotLoaded).first(), 'W3b in place of the checklist').toBeVisible();
      await main.getByRole('button', { name: 'Review and submit' }).click();
      await sleep(1_000);
      const trigger = main.getByRole('button', { name: SUBMIT_BUTTON });
      if ((await trigger.count()) > 0) {
        const t = trigger.first();
        const blocked = (await t.isDisabled()) || (await t.getAttribute('aria-disabled')) === 'true';
        expect(blocked, 'Submit is not available while the checklist did not load').toBe(true);
      }
      await rec.shot(page, 'A-parts-not-loaded');
      await restoreFaults();
    });

    await test.step('B. the re-read fails after a save that succeeded: form and typing stay, W2 and "Refresh again"; it recovers', async () => {
      const before = await sellingTotal(deal.id);
      await installFault('booking_form_get');
      await price.getByLabel('Adult markup per person, rupees').fill('2500');
      await until(async () => (await sellingTotal(deal.id)) !== before, 30_000, 'the price save stored');
      await expect(main.getByText(W.refreshFailed).first(), 'W2 at the top of the form').toBeVisible({ timeout: 20_000 });
      await expect(price.getByLabel('Adult markup per person, rupees'), 'typed value kept').toHaveValue('2500');
      await expect(page.getByText(W.bookingDidNotLoad)).toHaveCount(0);
      const again = main.getByRole('button', { name: W.refreshAgain });
      await expect(again).toBeVisible();
      await rec.shot(page, 'B-refresh-failed');
      await restoreFaults('booking_form_get');
      await again.click();
      await expect(main.getByText(W.refreshFailed), '"Refresh again" recovers').toHaveCount(0, { timeout: 20_000 });
      await expect(price.getByLabel('Adult markup per person, rupees')).toHaveValue('2500');
      await footerSettled(page);
    });

    await test.step('C. the same failure on a first load shows W4', async () => {
      await installFault('booking_form_get');
      await page.reload();
      await expect(page.getByText(W.bookingDidNotLoad).first(), 'W4 on the "Booking did not load" page').toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Nothing was changed'), 'the old wording is gone').toHaveCount(0);
      await restoreFaults('booking_form_get');
      await page.reload();
      await expect(main.locator('section#price')).toBeVisible({ timeout: 30_000 });
    });
    await rec.save();
    await context.close();
  });
});
