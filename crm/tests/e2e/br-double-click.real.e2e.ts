import { expect, test } from '@playwright/test';
import {
  configured,
  fillCustomer,
  footerSettled,
  gotoStep,
  loadFixture,
  nameRow,
  newDeal,
  newSalesContext,
  Recorder,
  requestedBrFile,
  restoreSwitch,
  saveActiveRecorder,
  sleep,
  startBooking,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1, item B1-7 (BR-36): a double click on the
 * footer step button no longer skips a step. REAL local Supabase stack,
 * production build. Asserts the FIXED behaviour (build contract section 6
 * B1-7, stress test a of section 8), so it fails on main and passes once
 * slice S3 is merged:
 *
 *   - a double click on "Go to step 2" ends on step 2 (not step 3);
 *   - a single click 500 ms later goes on to step 3;
 *   - Enter pressed twice at once, and Enter held (repeating keydown), on the
 *     focused footer button do not skip a step either.
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it.
 */

const FILE = 'br-double-click.real.e2e.ts';
const requested = requestedBrFile(FILE);

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

test.describe('B1-7: double click on the step button (fix batch 1) @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(saveActiveRecorder);
  test.afterAll(async () => {
    if (requested) await restoreSwitch(FILE);
  });

  test('double click and repeated Enter on "Go to step N" move one step only @br', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('br-double-click', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic double click');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await startBooking(rec, page, deal.id);
    await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
    await nameRow(rec, page, 1, 'Synthetic Click Adult', deal.id, 1);
    await footerSettled(page);

    await main.getByRole('button', { name: 'Go to step 2' }).dblclick();
    await expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 });
    await sleep(1_500);
    await expect(page, 'a double click ends on step 2').toHaveURL(/\/book\/stay/);

    await sleep(500);
    await main.getByRole('button', { name: 'Go to step 3' }).click();
    await expect(page, 'a click after 500 ms goes on to step 3').toHaveURL(/\/book\/finish/, { timeout: 30_000 });

    await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'back to step 1');
    await sleep(1_000);
    const step2 = main.getByRole('button', { name: 'Go to step 2' });
    await step2.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 });
    await sleep(1_500);
    await expect(page, 'Enter twice at once ends on step 2').toHaveURL(/\/book\/stay/);
    await expect(main.getByRole('button', { name: 'Go to step 3' }), 'the step button stays focusable (not disabled)').toBeEnabled();

    await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'back to step 1 again');
    await sleep(1_000);
    await main.getByRole('button', { name: 'Go to step 2' }).focus();
    // Held key: the first keydown plus repeating keydowns (repeat = true) before the key is released.
    await page.keyboard.down('Enter');
    for (let i = 0; i < 4; i += 1) {
      await sleep(40);
      await page.keyboard.down('Enter');
    }
    await page.keyboard.up('Enter');
    await expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 });
    await sleep(1_500);
    await expect(page, 'Enter held ends on step 2').toHaveURL(/\/book\/stay/);
    await rec.save();
    await context.close();
  });
});
