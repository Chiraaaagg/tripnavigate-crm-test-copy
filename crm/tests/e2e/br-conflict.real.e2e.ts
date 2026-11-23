import { type Browser, type BrowserContext, expect, test } from '@playwright/test';
import { BOOK_RELIABILITY_TEXT as W, ERROR_TEXT } from '../../src/modules/fulfilment/contracts';
import {
  addHotel,
  configured,
  fillCustomer,
  footerSettled,
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
  storedDestination,
  storedHotels,
  storedNames,
  until,
  watchSaveStates,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1, item B1-5 (BR-20, BR-34): a version
 * conflict is recoverable without retyping. Two browser windows of the same
 * Sales user on one draft, against the REAL local Supabase stack served by the
 * production build. Asserts the FIXED behaviour of build contract section 6
 * B1-5 (stress tests h and d of section 8), so each test fails on main and
 * passes once slice S3 is merged:
 *
 *   h1. Window B changes the customer card while window A has the hotel
 *       drawer open. A's Save is refused (the refusal stays), A presses
 *       "Load the latest and keep my entries" (W9a), sees W9b, presses Save:
 *       the hotel is stored once with A's values.
 *   h2. Window B changed the SAME hotel: A stays refused, W9c shows, B's hotel
 *       is what is stored; A's typed value is still on screen.
 *   d.  Window B is stale on the cards: its cards show the conflict text
 *       (ERROR_TEXT.version_changed, not a bare "Not saved") and W9a; after
 *       loading the latest the typed text is still on screen, nothing is sent
 *       by the re-base, and W9c says the same part was changed.
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it.
 */

const FILE = 'br-conflict.real.e2e.ts';
const requested = requestedBrFile(FILE);

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

const tag = () => String(Date.now()).slice(-8);

/** Same person, second window: the session copied into a second browser context. */
async function secondWindow(browser: Browser, context: BrowserContext, rec: Recorder) {
  const contextB = await browser.newContext({ storageState: await context.storageState() });
  await watchSaveStates(contextB);
  const b = await contextB.newPage();
  rec.attach(b, 'window-B');
  return { contextB, b };
}

async function setupWithHotel(browser: Browser, rec: Recorder, title: string) {
  const deal = await newDeal(tag(), title);
  const { context, page: a } = await newSalesContext(browser, rec, 'window-A');
  await startBooking(rec, a, deal.id);
  await fillCustomer(rec, a, { adults: '1', children: '0', infants: '0' });
  await nameRow(rec, a, 1, 'Synthetic Conflict Adult', deal.id, 1);
  await footerSettled(a);
  await addHotel(a, 'Synthetic Conflict Hotel', '7000');
  await until(async () => (await storedHotels(deal.id)).length === 1, 30_000, 'hotel stored');
  const editA = a.getByRole('dialog', { name: 'Edit hotel stay' });
  await a.locator('main').getByRole('button', { name: /^Edit hotel/ }).first().click();
  await expect(editA).toBeVisible({ timeout: 30_000 });
  return { deal, context, a, editA };
}

test.describe('B1-5: conflict recovery, two windows (fix batch 1) @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(saveActiveRecorder);
  test.afterAll(async () => {
    if (requested) await restoreSwitch(FILE);
  });

  test('h1: B changed the customer card; A loads the latest, keeps the hotel entries and saves once @br', async ({ browser }, testInfo) => {
    test.setTimeout(6 * 60_000);
    const rec = new Recorder('br-conflict-h1', testInfo);
    await loadFixture(testInfo);
    const { deal, context, editA } = await setupWithHotel(browser, rec, 'Synthetic conflict h1');
    const { contextB, b } = await secondWindow(browser, context, rec);
    await b.goto(`/app/deals/${deal.id}/book/travellers`);
    const destB = b.locator('main').getByLabel('Destination', { exact: true });
    await expect(destB).toBeVisible({ timeout: 30_000 });
    await destB.fill('Jodhpur from window B');
    await until(async () => (await storedDestination(deal.id)) === 'Jodhpur from window B', 30_000, "B's destination stored");

    await editA.getByLabel('Rooms: our cost per night').fill('7200');
    await editA.getByRole('button', { name: 'Save hotel' }).click();
    await expect(editA.getByText(ERROR_TEXT.version_changed), 'the refusal stays').toBeVisible({ timeout: 20_000 });
    const loadLatest = editA.getByRole('button', { name: W.loadLatestKeepEntries });
    await expect(loadLatest, 'W9a under the refusal').toBeVisible();
    await loadLatest.click();
    await expect(editA.getByText(W.latestLoadedKeepEntries), 'W9b after the re-base').toBeVisible({ timeout: 20_000 });
    await expect(editA.getByLabel('Rooms: our cost per night'), 'typed value kept').toHaveValue('7200');
    expect((await storedHotels(deal.id))[0]?.ratePaise, 'the re-base itself sent nothing').toBe('700000');
    await editA.getByRole('button', { name: 'Save hotel' }).click();
    await expect(editA).toBeHidden({ timeout: 30_000 });
    const hotels = await storedHotels(deal.id);
    expect(hotels, 'one hotel').toHaveLength(1);
    expect(hotels[0]!.ratePaise, "A's value stored").toBe('720000');
    expect(await storedDestination(deal.id), "B's customer change kept").toBe('Jodhpur from window B');
    await rec.save();
    await Promise.all([context.close(), contextB.close()]);
  });

  test("h2: B changed the same hotel; A stays refused, W9c shows, B's hotel is stored @br", async ({ browser }, testInfo) => {
    test.setTimeout(6 * 60_000);
    const rec = new Recorder('br-conflict-h2', testInfo);
    await loadFixture(testInfo);
    const { deal, context, editA } = await setupWithHotel(browser, rec, 'Synthetic conflict h2');
    const { contextB, b } = await secondWindow(browser, context, rec);
    await b.goto(`/app/deals/${deal.id}/book/stay`);
    await b.locator('main').getByRole('button', { name: /^Edit hotel/ }).first().click();
    const editB = b.getByRole('dialog', { name: 'Edit hotel stay' });
    await editB.getByLabel('Rooms: our cost per night').fill('7100');
    await editB.getByRole('button', { name: 'Save hotel' }).click();
    await expect(editB).toBeHidden({ timeout: 30_000 });
    await until(async () => (await storedHotels(deal.id))[0]?.ratePaise === '710000', 30_000, "B's hotel stored");

    await editA.getByLabel('Rooms: our cost per night').fill('7200');
    await editA.getByRole('button', { name: 'Save hotel' }).click();
    await expect(editA.getByText(ERROR_TEXT.version_changed)).toBeVisible({ timeout: 20_000 });
    const loadLatest = editA.getByRole('button', { name: W.loadLatestKeepEntries });
    await expect(loadLatest, 'W9a under the refusal').toBeVisible();
    await loadLatest.click();
    await expect(editA.getByText(W.sameItemChanged), 'W9c: a colleague changed this same hotel').toBeVisible({ timeout: 20_000 });
    await expect(editA.getByLabel('Rooms: our cost per night'), "A's typed value still on screen").toHaveValue('7200');
    await sleep(2_000);
    const hotels = await storedHotels(deal.id);
    expect(hotels).toHaveLength(1);
    expect(hotels[0]!.ratePaise, "B's hotel is stored, not overwritten").toBe('710000');
    await rec.save();
    await Promise.all([context.close(), contextB.close()]);
  });

  test('d: a stale second window shows the conflict on its cards and keeps the typed text after loading the latest @br', async ({ browser }, testInfo) => {
    test.setTimeout(6 * 60_000);
    const rec = new Recorder('br-conflict-d', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(tag(), 'Synthetic conflict d');
    const { context, page: a } = await newSalesContext(browser, rec, 'window-A');
    const mainA = a.locator('main');
    await startBooking(rec, a, deal.id);
    await fillCustomer(rec, a, { adults: '2', children: '0', infants: '0' });
    await nameRow(rec, a, 1, 'Synthetic Window Adult One', deal.id, 1);
    await footerSettled(a);
    const { contextB, b } = await secondWindow(browser, context, rec);
    const mainB = b.locator('main');
    await b.goto(`/app/deals/${deal.id}/book/travellers`);
    await expect(mainB.getByLabel('Destination', { exact: true })).toBeVisible({ timeout: 30_000 });

    await mainA.getByLabel('Destination', { exact: true }).fill('Jodhpur and Jaisalmer');
    await mainA.getByLabel('Passenger 2 full name').pressSequentially('Synthetic Window Adult Two A', { delay: 15 });
    await footerSettled(a);
    await until(async () => (await storedNames(deal.id)).length === 2, 30_000, "A's passenger 2 stored");

    await mainB.getByLabel('Destination', { exact: true }).fill('Jodhpur and Udaipur');
    await mainB.getByLabel('Passenger 2 full name').pressSequentially('Synthetic Window Adult Two B', { delay: 15 });
    await expect(mainB.getByText(ERROR_TEXT.version_changed).first(), 'stale cards give the conflict as their reason').toBeVisible({ timeout: 20_000 });
    const loadLatest = mainB.getByRole('button', { name: W.loadLatestKeepEntries });
    await expect(loadLatest.first(), 'W9a on the stale card').toBeVisible();
    await loadLatest.first().click();
    await expect(mainB.getByText(W.sameItemChanged).first(), 'W9c: A changed the same card').toBeVisible({ timeout: 20_000 });
    await sleep(2_000);
    await expect(mainB.getByLabel('Destination', { exact: true }), 'typed destination still on screen').toHaveValue('Jodhpur and Udaipur');
    await expect(mainB.getByLabel('Passenger 2 full name'), 'typed name still on screen').toHaveValue('Synthetic Window Adult Two B');
    expect(await storedDestination(deal.id), 'nothing sent by the re-base').toBe('Jodhpur and Jaisalmer');
    expect((await storedNames(deal.id)).sort()).toEqual(['Synthetic Window Adult One', 'Synthetic Window Adult Two A'].sort());
    await rec.save();
    await Promise.all([context.close(), contextB.close()]);
  });
});
