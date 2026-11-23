import { expect, test } from '@playwright/test';
import {
  configured,
  count,
  db,
  dbSnapshot,
  fillCustomer,
  footerSettled,
  footerText,
  gotoStep,
  loadFixture,
  nameRow,
  newDeal,
  newSalesContext,
  pillState,
  Recorder,
  requestedFile,
  restoreSwitch,
  saveMessageSettings,
  sleep,
  startBooking,
  syntheticPdf,
  TRIP,
  until,
  watchSaveStates,
} from './booking-reliability-support';

/**
 * INVESTIGATION ONLY (booking reliability, 19 November 2026). Not a gate.
 *
 * Short stress cases (a)-(e), (g), (h): repeated clicks, slow and offline
 * network, a lost answer after a server save, two windows on one draft, a
 * cleared session, a double-space name and a hotel editor conflict, against a REAL local Supabase stack served by the production build
 * (playwright.real.config.ts). Shared steps: booking-reliability-support.ts.
 * The journey and case (f) are in booking-reliability.real.e2e.ts.
 *
 * It records what a person would see and asserts nothing about success where
 * the right outcome is unknown. Numbers come from a GitHub runner with a local
 * stack, not from production. Runs ONLY when targeted.yml names this file
 * (JOURNEY_FILES) or BOOKING_INVESTIGATION=1; ci.yml skips every test here.
 */

const requested = requestedFile('booking-reliability-stress.real.e2e.ts');

// Bounded waits: a step that cannot act fails within 20 s and is recorded (Playwright's default is no action limit).
// Traces for every test (this file records, it does not judge). File level: Playwright refuses these inside a group.
test.use({ trace: 'on', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

test.describe('Booking reliability investigation: stress cases @investigation', () => {
  test.skip(!requested, 'Investigation only: runs when targeted.yml names this file (JOURNEY_FILES) or BOOKING_INVESTIGATION=1.');
  test.skip(requested && !configured, 'Real local Supabase stack not configured.');
  test.describe.configure({ mode: 'serial' });

  // A test that times out still leaves its JSON (timings, requests, problems).
  test.afterEach(async () => {
    const rec = Recorder.active;
    Recorder.active = null;
    if (rec && !rec.saved) await rec.save({ endedBy: 'afterEach (timeout or failure before the end of the test)' }).catch(() => undefined);
  });

  test.afterAll(async () => {
    if (requested) await restoreSwitch('booking-reliability-stress.real.e2e.ts');
  });

  test('(a) repeated clicks on save and attach @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('a-repeated-clicks', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic repeated clicks');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer, one named adult', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
      await nameRow(rec, page, 1, 'Synthetic Click Adult', deal.id, 1);
      await footerSettled(page);
    });
    await rec.run(page, 'Save message settings clicked 5 times fast', async () => {
      const card = page.locator('#book-message-prefs');
      if (!(await card.count())) throw new Error('Messages to the customer card not shown');
      const before = rec.requests.filter((r) => r.kind === 'server-action').length;
      const button = card.getByRole('button', { name: /Save message settings|Saving…/ });
      for (let i = 0; i < 5; i += 1) await button.click({ delay: 0, timeout: 5_000 }).catch(() => undefined);
      await until(async () => /Save message settings/.test((await button.textContent()) ?? ''), 30_000, 'settled');
      await sleep(1_000);
      rec.facts.messageSaveActionsSent = rec.requests.filter((r) => r.kind === 'server-action').length - before;
      rec.facts.messageSaveResult = ((await card.locator('[role="status"], [role="alert"]').allTextContents()) ?? []).join(' | ');
    });
    await rec.run(page, 'Attach ID proof: attach button clicked 3 times fast', async () => {
      await main.getByRole('button', { name: 'Attach ID proof for Synthetic Click Adult' }).click();
      const dialog = page.getByRole('dialog', { name: 'ID proof · Synthetic Click Adult' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await dialog.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-click.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('Synthetic click proof') });
      await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
      const attach = dialog.getByRole('button', { name: /Attach ID proof for|Attaching/ });
      for (let i = 0; i < 3; i += 1) await attach.click({ timeout: 3_000 }).catch(() => undefined);
      await expect(dialog).toBeHidden({ timeout: 30_000 }).catch(() => undefined);
      await sleep(1_500);
      rec.facts.storedProofsAfterTripleClick = await count("select count(*)::text as n from public.traveller_id_proofs where deal_id = $1 and status = 'stored'", [deal.id]);
    });
    await rec.run(page, 'Go to step 2 double-clicked; Save hotel double-clicked', async () => {
      await main.getByRole('button', { name: 'Go to step 2' }).dblclick();
      await expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 });
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').fill('Jodhpur');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Double Click Hotel');
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('7000');
      await d.getByRole('button', { name: 'Save hotel' }).dblclick();
      await expect(d).toBeHidden({ timeout: 30_000 }).catch(() => undefined);
      await sleep(1_500);
      rec.facts.dbAfterClicks = await dbSnapshot(deal.id);
    });
    await rec.save();
    await context.close();
  });

  test('(b) slow (3 s) server actions, then offline and recovery @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('b-slow-offline', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic slow network');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'start booking (normal network)', () => startBooking(rec, page, deal.id));
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (r.method() === 'POST' && r.headers()['next-action']) await sleep(3_000);
      await route.continue().catch(() => undefined);
    });
    await rec.run(page, 'with 3 s delay: customer card and two names', async () => {
      await fillCustomer(rec, page, { adults: '2', children: '0', infants: '0' });
      await nameRow(rec, page, 1, 'Synthetic Slow Adult One', deal.id, 1);
      await nameRow(rec, page, 2, 'Synthetic Slow Adult Two', deal.id, 2);
      await rec.timed('footer settles', async () => undefined, () => footerSettled(page, 30_000));
    });
    await rec.run(page, 'with 3 s delay: Save message settings, step move', async () => {
      if (await page.locator('#book-message-prefs').count()) await saveMessageSettings(rec, page, 'slow');
      await rec.timed('Go to step 2 (slow)', () => main.getByRole('button', { name: 'Go to step 2' }).click(), () => expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 }));
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'back to step 1 (slow)');
    });
    await rec.run(page, 'offline: edit a name, wait 15 s, see what shows', async () => {
      await context.setOffline(true);
      const box = main.getByLabel('Passenger 1 full name');
      await box.press('End');
      await box.pressSequentially(' Offline', { delay: 15 });
      await sleep(15_000);
      rec.facts.footerWhileOffline = await footerText(page);
      rec.facts.pillWhileOffline = await pillState(page, 'pill-passengers');
      await rec.shot(page, 'offline');
      await rec.surfaces(page, 'while offline');
    });
    await rec.run(page, 'back online: recovery within 60 s', async () => {
      await context.setOffline(false);
      const t = performance.now();
      await until(async () => /All changes saved/.test(await footerText(page)), 30_000, 'All changes saved after reconnect').catch((e: unknown) => rec.problem('no-recovery', String(e).slice(0, 200), page.url()));
      rec.facts.recoveryMs = Math.round(performance.now() - t);
      rec.facts.footerAfterOnline = await footerText(page);
      rec.facts.dbAfterOnline = await dbSnapshot(deal.id);
      await rec.shot(page, 'after-online');
    });
    await page.unroute('**/*');
    await rec.run(page, 'reload after recovery', async () => {
      await rec.timed('reload', () => page.reload(), () => expect(main.getByLabel('Passenger 1 full name')).toBeVisible({ timeout: 30_000 }));
      rec.facts.name1AfterReload = await main.getByLabel('Passenger 1 full name').inputValue();
    });
    await rec.save();
    await context.close();
  });

  test('(c) response lost after the server saved: no duplicate traveller or task @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('c-lost-response', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic lost response');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer card saved', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '2', children: '0', infants: '0' });
      await footerSettled(page);
    });
    let mode: 'drop' | 'delay' | 'off' = 'off';
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (r.method() !== 'POST' || !r.headers()['next-action'] || mode === 'off') return route.continue().catch(() => undefined);
      if (mode === 'drop') {
        mode = 'off';
        // The server receives and completes the action; the browser never gets the answer.
        const res = await route.fetch().catch(() => null);
        rec.problem('injected-drop', `server answered ${res?.status() ?? 'nothing'}; browser got a network failure`, r.url());
        return route.abort('failed').catch(() => undefined);
      }
      mode = 'off';
      await sleep(4_000);
      return route.continue().catch(() => undefined);
    });
    await rec.run(page, 'passenger save: answer dropped after the server saved', async () => {
      mode = 'drop';
      await main.getByLabel('Passenger 1 full name').pressSequentially('Synthetic Lost Adult One', { delay: 15 });
      await sleep(8_000);
      rec.facts.footerAfterDrop = await footerText(page);
      rec.facts.pillAfterDrop = await pillState(page, 'pill-passengers');
      await rec.shot(page, 'after-drop');
      // The person types on (the next save may resend the same row).
      await main.getByLabel('Passenger 2 full name').pressSequentially('Synthetic Lost Adult Two', { delay: 15 });
      await footerSettled(page, 30_000).catch(() => undefined);
      rec.facts.travellersAfterDrop = (await dbSnapshot(deal.id)).travellers;
    });
    await rec.run(page, 'ID proof upload: answer delayed 4 s, page reloaded mid-flight', async () => {
      await main.getByRole('button', { name: 'Attach ID proof for Synthetic Lost Adult One' }).click();
      const dialog = page.getByRole('dialog', { name: 'ID proof · Synthetic Lost Adult One' });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await dialog.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-lost.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('Synthetic lost proof') });
      await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
      mode = 'delay';
      await dialog.getByRole('button', { name: 'Attach ID proof for Synthetic Lost Adult One' }).click();
      await sleep(1_500);
      await page.reload();
      await expect(main.getByLabel('Passenger 1 full name')).toBeVisible({ timeout: 30_000 });
      await sleep(4_000);
      rec.facts.proofsAfterReloadMidFlight = (await dbSnapshot(deal.id)).idProofs;
      rec.facts.rowTextAfterReload = ((await main.locator('ol[aria-label="Passengers"]').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
    });
    await rec.run(page, 'hotel save: answer dropped; the person saves again', async () => {
      await main.getByRole('button', { name: 'Go to step 2' }).click();
      await expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 });
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').fill('Jodhpur');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Lost Answer Hotel');
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('8000');
      mode = 'drop';
      await d.getByRole('button', { name: 'Save hotel' }).click();
      await sleep(6_000);
      rec.facts.hotelDialogAfterDrop = { open: await d.isVisible(), text: ((await d.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-300) };
      await rec.shot(page, 'hotel-after-drop');
      if (await d.isVisible()) {
        await d.getByRole('button', { name: 'Save hotel' }).click().catch(() => undefined);
        await expect(d).toBeHidden({ timeout: 30_000 }).catch(() => undefined);
      }
      await sleep(2_000);
      rec.facts.dbAfterHotelDrop = await dbSnapshot(deal.id);
    });
    await page.unroute('**/*');
    await rec.save();
    await context.close();
  });

  test('(d) two browser windows edit the same draft (stale version) @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('d-two-windows', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic two windows');
    const { context, page: a } = await newSalesContext(browser, rec, 'window-A');
    await rec.run(a, 'A: start, customer card, two names', async () => {
      await startBooking(rec, a, deal.id);
      await fillCustomer(rec, a, { adults: '2', children: '0', infants: '0' });
      await nameRow(rec, a, 1, 'Synthetic Window Adult One', deal.id, 1);
      await footerSettled(a);
    });
    // Same person, second window: the same session copied into a second browser context.
    const contextB = await browser.newContext({ storageState: await context.storageState() });
    await watchSaveStates(contextB);
    const b = await contextB.newPage();
    rec.attach(b, 'window-B');
    await rec.run(b, 'B: open the same draft', async () => {
      await rec.timed('B opens step 1', () => b.goto(`/app/deals/${deal.id}/book/travellers`), () => expect(b.locator('main').getByLabel('Destination', { exact: true })).toBeVisible({ timeout: 30_000 }));
    });
    await rec.run(a, 'A: change destination and a name (B is now stale)', async () => {
      await a.locator('main').getByLabel('Destination', { exact: true }).fill('Jodhpur and Jaisalmer');
      await a.locator('main').getByLabel('Passenger 2 full name').pressSequentially('Synthetic Window Adult Two A', { delay: 15 });
      await footerSettled(a);
    });
    await rec.run(b, 'B (stale): change destination and the same name', async () => {
      await b.locator('main').getByLabel('Destination', { exact: true }).fill('Jodhpur and Udaipur');
      await b.locator('main').getByLabel('Passenger 2 full name').pressSequentially('Synthetic Window Adult Two B', { delay: 15 });
      await footerSettled(b, 30_000).catch(() => undefined);
      await sleep(2_000);
      rec.facts.bFooter = await footerText(b);
      rec.facts.bPills = { customer: await pillState(b, 'pill-customer'), passengers: await pillState(b, 'pill-passengers') };
      rec.facts.bAlerts = (await b.locator('main [role="alert"], main [role="status"]').allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10);
      await rec.shot(b, 'b-stale');
    });
    await rec.run(a, 'both reload; what each shows and what is stored', async () => {
      await Promise.all([a.reload(), b.reload()]);
      await Promise.all([
        expect(a.locator('main').getByLabel('Destination', { exact: true })).toBeVisible({ timeout: 30_000 }),
        expect(b.locator('main').getByLabel('Destination', { exact: true })).toBeVisible({ timeout: 30_000 }),
      ]);
      rec.facts.afterReload = {
        a: await a.locator('main').getByLabel('Destination', { exact: true }).inputValue(),
        b: await b.locator('main').getByLabel('Destination', { exact: true }).inputValue(),
        db: await db(async (c) => (await c.query("select trip_destination as destination from public.booking_versions where deal_id = $1 and status = 'draft'", [deal.id])).rows),
        travellers: (await dbSnapshot(deal.id)).travellers,
      };
      await rec.surfaces(b, 'window B after reload');
    });
    await rec.save();
    await Promise.all([context.close(), contextB.close()]);
  });

  test('(e) session cookie cleared mid-edit, then save @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('e-session-expiry', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic session expiry');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer card saved', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
      await footerSettled(page);
    });
    await rec.run(page, 'auth cookies cleared; edit destination (autosave)', async () => {
      await context.clearCookies({ name: /^sb-.*-auth-token(\.\d+)?$/ });
      await main.getByLabel('Destination', { exact: true }).fill('Jodhpur after expiry');
      await sleep(8_000);
      rec.facts.urlAfterAutosave = new URL(page.url()).pathname;
      rec.facts.footerAfterAutosave = await footerText(page);
      rec.facts.customerPill = await pillState(page, 'pill-customer');
      await rec.shot(page, 'after-autosave-signed-out');
    });
    await rec.run(page, 'press Save message settings while signed out', async () => {
      if (!(await page.locator('#book-message-prefs').count())) throw new Error('Messages to the customer card not shown');
      await saveMessageSettings(rec, page, 'signed out').catch((e: unknown) => rec.problem('save-message-signed-out', String(e).slice(0, 200), page.url()));
      await sleep(3_000);
      rec.facts.urlAfterSave = new URL(page.url()).pathname;
      await rec.shot(page, 'after-save-signed-out');
    });
    await rec.run(page, 'reload while signed out', async () => {
      await page.reload();
      await sleep(3_000);
      rec.facts.urlAfterReload = new URL(page.url()).pathname;
      rec.facts.destinationStored = await db(async (c) => (await c.query("select trip_destination as d from public.booking_versions where deal_id = $1 and status = 'draft'", [deal.id])).rows[0] ?? null);
    });
    await rec.save();
    await context.close();
  });
  test('(g) Attach ID proof on a name with two inner spaces @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('g-double-space-name', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic double space');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const name = 'Asha  Verma';
    await rec.run(page, 'setup: start, customer card, adult named "Asha  Verma" (two spaces), saved', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '1', children: '0', infants: '0' });
      await nameRow(rec, page, 1, name, deal.id, 1);
      await footerSettled(page);
      rec.facts.storedName = (await dbSnapshot(deal.id)).travellers;
      rec.facts.inputValueAfterSave = await main.getByLabel('Passenger 1 full name').inputValue();
    });
    await rec.run(page, 'press Attach ID proof: does the dialog open?', async () => {
      const button = main.locator('#passengers-1-idproof-open');
      rec.facts.buttonLabel = await button.getAttribute('aria-label');
      await button.click();
      const dialog = page.getByRole('dialog', { name: /^ID proof · / });
      const opened = await dialog.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
      rec.facts.dialogOpened = opened;
      rec.facts.dialogTitle = opened ? await dialog.getByRole('heading').first().textContent() : null;
      rec.facts.rowTexts = ((await main.locator('ol[aria-label="Passengers"]').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
      await rec.shot(page, opened ? 'dialog-open' : 'dialog-not-open');
      if (opened) {
        await dialog.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-space.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('Synthetic space proof') });
        await dialog.getByLabel('Customer agreed to share this ID for this booking').check();
        await dialog.getByRole('button', { name: /^Attach ID proof for/ }).click();
        rec.facts.closedAfterAttach = await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).then(() => true, () => false);
        rec.facts.dialogTextAfterAttach = ((await dialog.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-300);
        rec.facts.proofs = (await dbSnapshot(deal.id)).idProofs;
      }
    });
    await rec.save();
    await context.close();
  });

  test('(h) hotel editor version conflict between two windows; retry in the stale one @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(5 * 60_000);
    const rec = new Recorder('h-hotel-conflict', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic hotel conflict');
    const { context, page: a } = await newSalesContext(browser, rec, 'window-A');
    const mainA = a.locator('main');
    await rec.run(a, 'A: start, customer, one adult, one hotel', async () => {
      await startBooking(rec, a, deal.id);
      await fillCustomer(rec, a, { adults: '1', children: '0', infants: '0' });
      await nameRow(rec, a, 1, 'Synthetic Conflict Adult', deal.id, 1);
      await footerSettled(a);
      await mainA.getByRole('button', { name: 'Go to step 2' }).click();
      await expect(a).toHaveURL(/\/book\/stay/, { timeout: 30_000 });
      await mainA.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await mainA.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = a.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').fill('Jodhpur');
      await d.getByLabel('Hotel', { exact: true }).fill('Synthetic Conflict Hotel');
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('7000');
      await d.getByRole('button', { name: 'Save hotel' }).click();
      await expect(d).toBeHidden({ timeout: 30_000 });
    });
    const editA = a.getByRole('dialog', { name: 'Edit hotel stay' });
    await rec.run(a, 'A: open the hotel editor and leave it open', async () => {
      await mainA.getByRole('button', { name: /^Edit hotel/ }).first().click();
      await expect(editA).toBeVisible({ timeout: 30_000 });
    });
    const contextB = await browser.newContext({ storageState: await context.storageState() });
    await watchSaveStates(contextB);
    const b = await contextB.newPage();
    rec.attach(b, 'window-B');
    await rec.run(b, 'B: change the same hotel and save', async () => {
      await b.goto(`/app/deals/${deal.id}/book/stay`);
      await b.locator('main').getByRole('button', { name: /^Edit hotel/ }).first().click();
      const e = b.getByRole('dialog', { name: 'Edit hotel stay' });
      await e.getByLabel('Rooms: our cost per night').fill('7100');
      await rec.timed('B: Save hotel', () => e.getByRole('button', { name: 'Save hotel' }).click(), () => expect(e).toBeHidden({ timeout: 30_000 }));
    });
    const dialogState = async () => ({
      open: await editA.isVisible(),
      alerts: (await editA.locator('[role="alert"], [role="status"]').allTextContents().catch(() => [] as string[])).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean),
      tail: ((await editA.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(-300),
    });
    await rec.run(a, 'A (stale): change cost, Save hotel', async () => {
      await editA.getByLabel('Rooms: our cost per night').fill('7200');
      await editA.getByRole('button', { name: 'Save hotel' }).click();
      await sleep(6_000);
      rec.facts.aFirstSave = await dialogState();
      await rec.shot(a, 'a-first-save');
    });
    await rec.run(a, 'A: press Save hotel again (retry)', async () => {
      if (!(await editA.isVisible())) {
        rec.facts.aRetry = 'dialog already closed after the first save';
        return;
      }
      await editA.getByRole('button', { name: 'Save hotel' }).click();
      await sleep(6_000);
      rec.facts.aRetry = await dialogState();
      await rec.shot(a, 'a-retry');
      if (await editA.isVisible()) {
        await editA.getByRole('button', { name: 'Save hotel' }).click();
        await sleep(6_000);
        rec.facts.aThirdTry = await dialogState();
      }
    });
    await rec.run(a, 'what is stored; A after reload', async () => {
      rec.facts.storedHotel = await db(async (c) => (await c.query(
        `select f.facts ->> 'hotelName' as hotel, f.facts ->> 'roomRatePaise' as rate_paise, f.facts as facts from public.service_item_facts f
         join public.booking_versions v on v.id = f.booking_version_id join public.service_items i on i.id = f.service_item_id
         where v.deal_id = $1 and v.status = 'draft' and i.service_type = 'hotel'`, [deal.id])).rows.map((r: Record<string, unknown>) => JSON.stringify(r).slice(0, 600)));
      await a.reload();
      await expect(mainA).toContainText('Synthetic Conflict Hotel', { timeout: 30_000 });
    });
    await rec.save();
    await Promise.all([context.close(), contextB.close()]);
  });
});
