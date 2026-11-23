import { expect, test } from '@playwright/test';
import {
  addHotel,
  attachProof,
  configured,
  dataApiCalls,
  fillCustomer,
  footerSettled,
  footerText,
  gotoStep,
  loadFixture,
  nameRow,
  newDeal,
  newSalesContext,
  Recorder,
  requestedBrFile,
  requestSummary,
  restoreSwitch,
  saveActiveRecorder,
  sleep,
  startBooking,
  storedDestination,
  until,
  watchRequests,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1, item B1-6 (BR-10, BR-11): one re-render
 * per save, no menu-link re-fetch storm. The M0 counters (addendum 2,
 * br-m0-measure.real.e2e.ts) as assertions, with the lead's decision
 * BOOK_SAVE_REFRESH_MODE = 'server' (refresh() in the action, no
 * router.refresh(), no revalidatePath on a draft save, menu prefetch on).
 * REAL local Supabase stack, production build. Fails on main (1 POST + 1 GET
 * + 10 to 12 prefetches, booking_form_get 3 per save) and passes once slices
 * S4 and S3 are merged.
 *
 * Per save, from the action until 4 s after the screen settled:
 *   - passenger autosave and hotel drawer save: 1 action POST, 0 page GETs,
 *     0 prefetches; booking_form_get at most 2;
 *   - ID-proof attach: its 2 action POSTs (start and finish), 0 page GETs,
 *     0 prefetches;
 *   - the next save of another card succeeds (the new row version reached
 *     the form);
 *   - the Deal page opened by its link shows the new hotel;
 *   - a menu link still shows its loading state at once.
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it.
 */

const FILE = 'br-requests-per-save.real.e2e.ts';
const requested = requestedBrFile(FILE);
const FUNCTIONS = ['booking_form_get', 'booking_panel', 'intake_checklist', 'my_work_counts'] as const;

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

test.describe('B1-6: requests per Book now save (fix batch 1) @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(saveActiveRecorder);
  test.afterAll(async () => {
    if (requested) await restoreSwitch(FILE);
  });

  test('passenger autosave, ID-proof attach and hotel save: 1 POST each (2 for the attach), 0 extra GETs @br', async ({ browser }, testInfo) => {
    test.setTimeout(8 * 60_000);
    const rec = new Recorder('br-requests-per-save', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic requests per save');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const seen = watchRequests(page);
    const perSave: Array<Record<string, unknown>> = [];

    const measure = async (label: string, act: () => Promise<void>) => {
      await sleep(2_500);
      const from = seen.length;
      const before = await dataApiCalls(FUNCTIONS);
      await act();
      await footerSettled(page).catch(() => undefined);
      await sleep(4_000);
      const after = await dataApiCalls(FUNCTIONS);
      const row = { save: label, ...requestSummary(seen.slice(from)), dataApiCalls: Object.fromEntries(FUNCTIONS.map((f) => [f, after[f]! - (before[f] ?? 0)])) };
      perSave.push(row);
      rec.facts.perSave = perSave;
      return row;
    };

    await startBooking(rec, page, deal.id);
    await fillCustomer(rec, page, { adults: '2', children: '0', infants: '0' });
    await footerSettled(page);

    for (const [n, name] of [
      [1, 'Synthetic Count Adult One'],
      [2, 'Synthetic Count Adult Two'],
    ] as const) {
      const r = await measure(`passenger autosave ${n}`, () => nameRow(rec, page, n, name, deal.id, n));
      expect.soft(r.serverActionPosts, `${r.save}: action POSTs`).toBe(1);
      expect.soft(r.pageGets, `${r.save}: page GETs`).toBe(0);
      expect.soft(r.prefetchGets, `${r.save}: menu prefetches`).toBe(0);
      expect.soft(r.dataApiCalls.booking_form_get, `${r.save}: booking_form_get`).toBeLessThanOrEqual(2);
    }

    const proof = await measure('ID-proof attach', () => attachProof(rec, page, 'Synthetic Count Adult One', 'count', false));
    expect.soft(proof.serverActionPosts, 'ID-proof attach: action POSTs (start and finish)').toBeLessThanOrEqual(2);
    expect.soft(proof.pageGets, 'ID-proof attach: page GETs').toBe(0);
    expect.soft(proof.prefetchGets, 'ID-proof attach: menu prefetches').toBe(0);

    await gotoStep(rec, page, /Trip & services/, /\/book\/stay/, 'step 1 → step 2');
    await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
    await footerSettled(page).catch(() => undefined);
    const hotel = await measure('hotel drawer save', () => addHotel(page, 'Synthetic Count Hotel', '7000'));
    expect.soft(hotel.serverActionPosts, 'hotel save: action POSTs').toBe(1);
    expect.soft(hotel.pageGets, 'hotel save: page GETs').toBe(0);
    expect.soft(hotel.prefetchGets, 'hotel save: menu prefetches (no revalidatePath on a draft save)').toBe(0);
    expect.soft(hotel.dataApiCalls.booking_form_get, 'hotel save: booking_form_get').toBeLessThanOrEqual(2);

    await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'step 2 → step 1');
    const dest = main.getByLabel('Destination', { exact: true });
    await dest.fill('Jodhpur after counted saves');
    await until(async () => (await storedDestination(deal.id)) === 'Jodhpur after counted saves', 30_000, 'next save of another card stored');
    await footerSettled(page);
    expect(await footerText(page), 'the next save succeeded (row version reached the form)').toMatch(/All changes saved/);
    await expect(main.getByRole('alert')).toHaveCount(0);

    const link = page.locator(`a[href="/app/deals/${deal.id}"]`).first();
    if ((await link.count()) > 0) await link.click();
    else await page.goto(`/app/deals/${deal.id}`);
    await expect(page).toHaveURL(new RegExp(`/app/deals/${deal.id}$`), { timeout: 30_000 });
    await expect(main, 'the Deal page shows the new hotel').toContainText('Synthetic Count Hotel', { timeout: 30_000 });

    const menu = page.locator('nav a[href="/app/deals"]').first();
    const started = Date.now();
    await menu.click();
    let busyAtMs: number | null = null;
    for (let i = 0; i < 60 && busyAtMs === null; i += 1) {
      if ((await page.locator('main [aria-busy="true"], main [role="status"]:has-text("Loading")').count().catch(() => 0)) > 0) busyAtMs = Date.now() - started;
      else if (/\/app\/deals$/.test(page.url()) && (await main.getByRole('heading').count().catch(() => 0)) > 0) break;
      await sleep(50);
    }
    await expect(page).toHaveURL(/\/app\/deals$/, { timeout: 30_000 });
    rec.facts.menuLink = { loadingStateAtMs: busyAtMs };
    expect.soft(busyAtMs, 'a menu link still shows its loading state at once').not.toBeNull();

    await rec.save();
    await context.close();
  });
});
