import { expect, type Page, test } from '@playwright/test';
import { BOOK_RELIABILITY_TEXT as W } from '../../src/modules/fulfilment/contracts';
import {
  attachProof,
  configured,
  count,
  fillCustomer,
  footerSettled,
  footerText,
  loadFixture,
  nameRow,
  newDeal,
  newSalesContext,
  pillState,
  Recorder,
  refusalOnScreen,
  requestedBrFile,
  restoreSwitch,
  rowValues,
  saveActiveRecorder,
  sleep,
  startBooking,
  storedNames,
  until,
  watchRequests,
} from './booking-reliability-support';

/**
 * Booking reliability fix batch 1, item B1-4 (BR-02, BR-03, BR-32, BR-33) and
 * item B1-9 (BR-04, P0-3): the passengers card, end to end against the REAL
 * local Supabase stack served by the production build
 * (playwright.real.config.ts). Asserts the FIXED behaviour of build contract
 * section 6 (B1-4 table rows a to f, addendum 1 B1-9), so every test here
 * fails on main and passes once slices S3 and S4 are merged.
 *
 *   1. Rapid typing: names typed in three rows while a save is held 3 s,
 *      20 repetitions: the refusal never shows; every name stored once (a).
 *   2. Slot stability: row 3 typed alone stays in row 3; row 1 next gives two
 *      separate passengers, no joined name (b).
 *   3. Lost answer: the server stored the passenger but the browser lost the
 *      answer; without reloading, passenger 2 and an ID proof work, each
 *      stored once (c, e).
 *   4. Offline: the edit is kept with W6a and "Try again"; nothing is sent by
 *      itself after reconnecting; "Try again" stores it once; the browser asks
 *      before leaving while the card is unsent (d, e, f).
 *   5. B1-9: renaming a passenger with stored ID proofs asks first (W12);
 *      "Keep the old name" sends nothing and keeps the proofs.
 *
 * Synthetic data only. Runs when targeted.yml names this file (JOURNEY_FILES)
 * or BR_JOURNEYS=1; ci.yml skips it. Recorder JSON (requests, page errors,
 * screenshots) is written for each test under
 * test-results/real-journey/booking-reliability/.
 */

const FILE = 'br-passengers.real.e2e.ts';
const requested = requestedBrFile(FILE);
const REPS = Number(process.env.BR_REPEAT ?? 20);
const WORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'];

test.use({ trace: 'retain-on-failure', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

const tag = () => String(Date.now()).slice(-8);
const pax = (page: Page, row: number) => page.locator('main').getByLabel(`Passenger ${row} full name`);

test.describe('B1-4 and B1-9: passengers card (fix batch 1) @br', () => {
  test.skip(!requested, 'Fix batch 1 journey: runs when targeted.yml names this file (JOURNEY_FILES) or BR_JOURNEYS=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');

  test.afterEach(saveActiveRecorder);
  test.afterAll(async () => {
    if (requested) await restoreSwitch(FILE);
  });

  test(`B1-4 a: names typed in three rows during a 3 s save, ${REPS} repetitions: no refusal, each name stored once @br`, async ({ browser }, testInfo) => {
    test.setTimeout(25 * 60_000);
    const rec = new Recorder('br-pax-rapid', testInfo);
    await loadFixture(testInfo);
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const seen = watchRequests(page);
    let hold = false;
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (hold && r.method() === 'POST' && r.headers()['next-action']) await sleep(3_000);
      await route.continue().catch(() => undefined);
    });
    const outcomes: Array<{ rep: number; ok: boolean; refusals: string[]; pillFix: boolean; stored: string[]; typed: string[] }> = [];
    for (let rep = 1; rep <= REPS; rep += 1) {
      const word = WORDS[(rep - 1) % WORDS.length]!;
      const typed = [`Synthetic Rapid ${word} One`, `Synthetic Rapid ${word} Two`, `Synthetic Rapid ${word} Three`];
      const deal = await newDeal(tag(), `Synthetic rapid typing ${word}`);
      hold = false;
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '3', children: '0', infants: '0' });
      await footerSettled(page);
      await sleep(1_000);
      hold = true;
      const from = seen.length;
      await pax(page, 1).pressSequentially(typed[0]!, { delay: 15 });
      // Passenger 1's save is on the wire (held 3 s): type passengers 2 and 3 meanwhile.
      await until(async () => seen.slice(from).some((r) => r.kind === 'server-action'), 10_000, 'passenger 1 save sent');
      await pax(page, 2).pressSequentially(typed[1]!, { delay: 15 });
      await pax(page, 3).pressSequentially(typed[2]!, { delay: 15 });
      const refusals = new Set<string>();
      let pillFix = false;
      const end = Date.now() + 45_000;
      for (;;) {
        for (const r of await refusalOnScreen(page)) refusals.add(r);
        if ((await pillState(page, 'pill-passengers')) === 'fix') pillFix = true;
        const stored = await storedNames(deal.id);
        if ((stored.length >= 3 && /All changes saved/.test(await footerText(page))) || Date.now() > end) break;
        await sleep(250);
      }
      hold = false;
      await sleep(1_500);
      for (const r of await refusalOnScreen(page)) refusals.add(r);
      const stored = await storedNames(deal.id);
      const ok = refusals.size === 0 && !pillFix && stored.length === 3 && typed.every((n) => stored.filter((s) => s === n).length === 1);
      outcomes.push({ rep, ok, refusals: [...refusals], pillFix, stored, typed });
      rec.facts.outcomes = outcomes;
      if (!ok) await rec.shot(page, `rapid-rep-${rep}-failed`);
      // Three failed repetitions are enough evidence; the rest would only cost time.
      if (outcomes.filter((o) => !o.ok).length >= 3) break;
    }
    await page.unroute('**/*');
    await rec.save({ reps: REPS });
    await context.close();
    expect(outcomes.filter((o) => !o.ok), 'repetitions with a refusal, a "needs a fix" pill or a name not stored exactly once').toEqual([]);
    expect(outcomes, 'every repetition ran').toHaveLength(REPS);
  });

  test('B1-4 b: a name typed in row 3 stays in row 3; row 1 next gives two separate passengers @br', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('br-pax-slots', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(tag(), 'Synthetic slot stability');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const three = 'Synthetic Slot Adult Three';
    const one = 'Synthetic Slot Adult One';
    await startBooking(rec, page, deal.id);
    await fillCustomer(rec, page, { adults: '3', children: '0', infants: '0' });
    await footerSettled(page);
    await nameRow(rec, page, 3, three, deal.id, 1);
    await footerSettled(page);
    await sleep(2_500); // the save's re-render has arrived
    expect(await rowValues(page), 'row 3 keeps its name; rows 1 and 2 stay empty').toEqual(['', '', three]);
    await nameRow(rec, page, 1, one, deal.id, 2);
    await footerSettled(page);
    await sleep(2_500);
    const stored = await storedNames(deal.id);
    expect([...stored].sort(), 'two separate passengers stored').toEqual([one, three].sort());
    expect(stored.some((s) => s.includes(one) && s.includes(three)), 'no joined name').toBe(false);
    expect(await rowValues(page), 'each name in the row it was typed in').toEqual([one, '', three]);
    expect(await refusalOnScreen(page)).toEqual([]);
    await rec.save();
    await context.close();
  });

  test('B1-4 c: answer lost after the server stored; passenger 2 and an ID proof still work, each stored once @br', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('br-pax-lost-answer', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(tag(), 'Synthetic lost answer');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const one = 'Synthetic Lost Adult One';
    const two = 'Synthetic Lost Adult Two';
    await startBooking(rec, page, deal.id);
    await fillCustomer(rec, page, { adults: '2', children: '0', infants: '0' });
    await footerSettled(page);
    await sleep(1_000);
    let drop = false;
    let dropped = false;
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (!drop || r.method() !== 'POST' || !r.headers()['next-action']) return route.continue().catch(() => undefined);
      drop = false;
      // The server receives and completes the save; the browser never gets the answer.
      await route.fetch().catch(() => null);
      dropped = true;
      return route.abort('failed').catch(() => undefined);
    });
    drop = true;
    await pax(page, 1).pressSequentially(one, { delay: 15 });
    await until(async () => dropped, 15_000, 'the passengers save was answered by the server and the answer dropped');
    expect(await storedNames(deal.id), 'the server stored passenger 1').toEqual([one]);
    // Fixed behaviour: the card checks what was stored (a read) and says so (W5), or offers "Try again", which reads first.
    const found = main.getByText(W.passengersFoundSaved);
    const tryAgain = main.getByRole('button', { name: W.tryAgain });
    await expect(found.or(tryAgain).first(), 'W5, or "Try again", after the lost answer').toBeVisible({ timeout: 20_000 });
    if (await tryAgain.isVisible().catch(() => false)) {
      await tryAgain.first().click();
      await expect(tryAgain).toHaveCount(0, { timeout: 20_000 });
    }
    expect(await storedNames(deal.id), 'still one passenger 1').toEqual([one]);
    await pax(page, 2).pressSequentially(two, { delay: 15 });
    await until(async () => (await storedNames(deal.id)).length >= 2, 30_000, 'passenger 2 stored');
    await footerSettled(page);
    expect(await refusalOnScreen(page), 'no passengers refusal').toEqual([]);
    expect(await pillState(page, 'pill-passengers')).not.toBe('fix');
    await attachProof(rec, page, one, 'lost', false);
    await sleep(1_500);
    const stored = await storedNames(deal.id);
    expect(stored.filter((n) => n === one), 'passenger 1 stored once').toHaveLength(1);
    expect(stored.filter((n) => n === two), 'passenger 2 stored once').toHaveLength(1);
    expect(stored).toHaveLength(2);
    expect(await count("select count(*)::text as n from public.traveller_id_proofs where deal_id = $1 and status = 'stored'", [deal.id]), 'the ID proof stored').toBe(1);
    await page.unroute('**/*');
    await rec.save();
    await context.close();
  });

  test('B1-4 d: an offline edit is kept, nothing is sent by itself, "Try again" stores it once; leaving asks first @br', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('br-pax-offline', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(tag(), 'Synthetic offline edit');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const seen = watchRequests(page);
    const original = 'Synthetic Offline Adult';
    const edited = `${original} Edited`;
    await startBooking(rec, page, deal.id);
    await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
    await nameRow(rec, page, 1, original, deal.id, 1);
    await footerSettled(page);
    await sleep(1_500);

    await context.setOffline(true);
    await pax(page, 1).press('End');
    await pax(page, 1).pressSequentially(' Edited', { delay: 15 });
    await expect(main.getByText(W.offlineNotSaved).first(), 'W6a while offline').toBeVisible({ timeout: 20_000 });
    await expect(main.getByRole('button', { name: W.tryAgain }).first()).toBeVisible();
    await expect(pax(page, 1)).toHaveValue(edited);

    // f: the unsent card counts as unsaved; closing or reloading asks first (beforeunload).
    const asked = page.waitForEvent('dialog', { timeout: 10_000 }).then(async (d) => {
      const type = d.type();
      await d.dismiss();
      return type;
    });
    await page.close({ runBeforeUnload: true });
    expect(await asked.catch(() => 'no dialog'), 'the browser asks before leaving').toBe('beforeunload');
    expect(page.isClosed(), 'the page stays open after "stay"').toBe(false);

    await context.setOffline(false);
    const postsBefore = seen.filter((r) => r.kind === 'server-action').length;
    await sleep(6_000);
    expect(seen.filter((r) => r.kind === 'server-action').length - postsBefore, 'nothing sent by itself after reconnecting').toBe(0);
    expect(await storedNames(deal.id), 'still the old name in the database').toEqual([original]);

    await main.getByRole('button', { name: W.tryAgain }).first().click();
    await until(async () => (await storedNames(deal.id))[0] === edited, 30_000, 'edited name stored after "Try again"');
    await footerSettled(page);
    expect(await storedNames(deal.id), 'one passenger, edited').toEqual([edited]);
    await expect(main.getByText(W.offlineNotSaved)).toHaveCount(0);
    expect(await refusalOnScreen(page)).toEqual([]);
    await page.reload();
    await expect(pax(page, 1)).toHaveValue(edited, { timeout: 30_000 });
    await rec.save();
    await context.close();
  });

  test('B1-9: renaming a passenger with ID proofs asks first; "Keep the old name" sends nothing and keeps the proofs @br', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('br-pax-rename-proofs', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(tag(), 'Synthetic rename with proofs');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const seen = watchRequests(page);
    const original = 'Synthetic Rename Adult';
    const proofs = () => count("select count(*)::text as n from public.traveller_id_proofs where deal_id = $1 and status = 'stored'", [deal.id]);
    await startBooking(rec, page, deal.id);
    await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
    await nameRow(rec, page, 1, original, deal.id, 1);
    await footerSettled(page);
    await attachProof(rec, page, original, 'rename', false);
    await until(async () => (await proofs()) === 1, 30_000, 'one stored ID proof');
    await footerSettled(page);
    await sleep(1_500);

    const confirm = page.getByRole('dialog').filter({ hasText: W.renameRemovesIdProofs });
    const postsBefore = seen.filter((r) => r.kind === 'server-action').length;
    await pax(page, 1).press('End');
    await pax(page, 1).pressSequentially(' Renamed', { delay: 15 });
    await expect(confirm, 'W12 asks before the rename is saved').toBeVisible({ timeout: 15_000 });
    expect(seen.filter((r) => r.kind === 'server-action').length - postsBefore, 'nothing sent while asking').toBe(0);
    await confirm.getByRole('button', { name: W.renameKeep }).last().click();
    await expect(confirm).toBeHidden({ timeout: 10_000 });
    await expect(pax(page, 1), '"Keep the old name" restores it').toHaveValue(original);
    await sleep(3_000);
    expect(seen.filter((r) => r.kind === 'server-action').length - postsBefore, '"Keep the old name" sends nothing').toBe(0);
    expect(await storedNames(deal.id)).toEqual([original]);
    expect(await proofs(), 'the proof is kept').toBe(1);

    await pax(page, 1).press('End');
    await pax(page, 1).pressSequentially(' Renamed', { delay: 15 });
    await expect(confirm).toBeVisible({ timeout: 15_000 });
    await confirm.getByRole('button', { name: W.renameConfirm }).click();
    await until(async () => (await storedNames(deal.id))[0] === `${original} Renamed`, 30_000, 'renamed passenger stored');
    await until(async () => (await proofs()) === 0, 30_000, 'the proof removed by the confirmed rename (rule unchanged)');
    await rec.save();
    await context.close();
  });
});
