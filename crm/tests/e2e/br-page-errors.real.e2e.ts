import { expect, type Page, test } from '@playwright/test';
import {
  configured,
  fillCustomer,
  footerSettled,
  gotoStep,
  loadFixture,
  nameRow,
  newDeal,
  newSalesContext,
  pageErrors,
  Recorder,
  requestedBrFile,
  restoreSwitch,
  saveActiveRecorder,
  sleep,
  startBooking,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1, item B1-2 (BR-25): the live-connection
 * fallback no longer calls itself. Realtime is not started on CI, so every
 * signed-in page takes the fallback path. REAL local Supabase stack,
 * production build. Asserts the FIXED behaviour (contract section 6 B1-2:
 * page-error count 0) on /app, the Deal page and each Book now step: no
 * uncaught page error at all, "Maximum call stack size exceeded" included.
 * Fails on main and passes once slice S2 is merged.
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it.
 */

const FILE = 'br-page-errors.real.e2e.ts';
const requested = requestedBrFile(FILE);
/** Long enough for the live connection to give up and fall back to polling. */
const DWELL_MS = Number(process.env.BR_PAGE_DWELL_MS ?? 8_000);

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

test.describe('B1-2: no page errors on signed-in pages (fix batch 1) @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(saveActiveRecorder);
  test.afterAll(async () => {
    if (requested) await restoreSwitch(FILE);
  });

  test('/app, the Deal page and the three Book now steps have 0 page errors @br', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('br-page-errors', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic page errors');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const perPage: Record<string, string[]> = {};
    const dwell = async (label: string, p: Page) => {
      const from = pageErrors(rec).length;
      await sleep(DWELL_MS);
      perPage[label] = pageErrors(rec).slice(from);
      expect(p.isClosed()).toBe(false);
    };

    await page.goto('/app');
    await expect(main).toBeVisible({ timeout: 30_000 });
    await dwell('/app', page);
    await startBooking(rec, page, deal.id); // opens the Deal page first
    await dwell('Book now step 1 (after the Deal page)', page);
    await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
    await nameRow(rec, page, 1, 'Synthetic Errors Adult', deal.id, 1);
    await footerSettled(page);
    await gotoStep(rec, page, /Trip & services/, /\/book\/stay/, 'step 1 → step 2');
    await dwell('Book now step 2', page);
    await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 2 → step 3');
    await dwell('Book now step 3', page);
    await page.goto(`/app/deals/${deal.id}`);
    await expect(main).toBeVisible({ timeout: 30_000 });
    await dwell('Deal page', page);

    rec.facts.pageErrorsPerPage = perPage;
    await rec.save();
    await context.close();
    const all = pageErrors(rec);
    expect(all.filter((e) => /Maximum call stack size exceeded/.test(e)), 'no stack overflow (BR-25)').toEqual([]);
    expect(all, 'no page error at all').toEqual([]);
  });
});
