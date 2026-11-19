import { expect, test } from '@playwright/test';
import { istToday } from '../helpers/browser-journey';
import {
  attachProof,
  configured,
  db,
  dbSnapshot,
  fillCustomer,
  footerSaving,
  footerSettled,
  footerText,
  gotoStep,
  IDLE_MS,
  loadFixture,
  mainAlerts,
  nameRow,
  newDeal,
  newSalesContext,
  pillIs,
  pillState,
  Recorder,
  refusalOnScreen,
  reloadAfterRefusal,
  rowValues,
  requestedFile,
  restoreSwitch,
  saveMessageSettings,
  sleep,
  startBooking,
  SUBMIT_BUTTON,
  SUBMIT_DIALOG,
  syntheticPdf,
  TRIP,
  until,
  WHATSAPP,
} from './booking-reliability-support';

/**
 * INVESTIGATION ONLY (booking reliability, 19 November 2026). Not a gate.
 *
 * One continuous Sales journey on a Deal at "Won - Payment Received" (Book now
 * from Deal to Submit, with a long idle) and the in-flight passenger save case
 * (f), against a REAL local Supabase stack served by the production build
 * (playwright.real.config.ts). Shared steps: booking-reliability-support.ts.
 * The short stress cases are in booking-reliability-stress.real.e2e.ts.
 *
 * It records what a person would see and asserts nothing about success where
 * the right outcome is unknown. Numbers come from a GitHub runner with a local
 * stack, not from production. Runs ONLY when targeted.yml names this file
 * (JOURNEY_FILES) or BOOKING_INVESTIGATION=1; ci.yml skips every test here.
 */

const requested = requestedFile('booking-reliability.real.e2e.ts');

// Bounded waits: a step that cannot act fails within 20 s and is recorded (Playwright's default is no action limit).
// Traces for every test (this file records, it does not judge). File level: Playwright refuses these inside a group.
test.use({ trace: 'on', screenshot: 'on', video: 'off', actionTimeout: 20_000, navigationTimeout: 45_000 });

test.describe('Booking reliability investigation: journey @investigation', () => {
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
    if (requested) await restoreSwitch('booking-reliability.real.e2e.ts');
  });

  test('journey: one Sales booking from Deal to Submit with timings @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const testStart = Date.now();
    const rec = new Recorder('journey', testInfo);
    const tag = String(Date.now()).slice(-8);
    await loadFixture(testInfo);
    const deal = await newDeal(tag, 'Synthetic booking reliability journey');
    rec.facts.deal = { kind: deal.kind, note: deal.note };
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    const names = ['Synthetic Rel Adult One', 'Synthetic Rel Adult Two', 'Synthetic Rel Child', 'Synthetic Rel Infant'];

    await rec.run(page, '01 open Deal, Start booking', () => startBooking(rec, page, deal.id));

    await rec.run(page, '02 customer card, 2 adults + 1 child + 1 infant', async () => {
      await fillCustomer(rec, page, { adults: '2', children: '1', infants: '1' });
      await expect(main.locator('[name="travellerName"]')).toHaveCount(4, { timeout: 30_000 });
    });

    await rec.run(page, '03 traveller names, rapid typing (rows 1, 3, 4)', async () => {
      await nameRow(rec, page, 1, names[0]!, deal.id, 1);
      await nameRow(rec, page, 3, names[2]!, deal.id, 2);
      await nameRow(rec, page, 4, names[3]!, deal.id, 3);
      await rec.timed('footer settles after the names', async () => undefined, () => footerSettled(page));
    });

    await rec.run(
      page,
      '03b if a passengers refusal shows: what Reload does, then type back what is missing',
      async () => {
        const refusal = await refusalOnScreen(page);
        rec.facts.rowsAfterStep03 = await rowValues(page);
        rec.facts.refusalAfterStep03 = { refusal, pill: await pillState(page, 'pill-passengers'), footer: await footerText(page), alerts: await mainAlerts(page) };
        if (refusal.length === 0 && (await pillState(page, 'pill-passengers')) !== 'fix') return;
        await reloadAfterRefusal(rec, page, deal.id, [names[0]!, '', names[2]!, names[3]!]);
        rec.resume();
      },
      { always: true },
    );

    await rec.run(page, '04 child and infant: Details drawer, date of birth (age field noted)', async () => {
      const drawer = page.getByRole('dialog', { name: 'Passenger details' });
      for (const [row, dob] of [
        [3, '2018-05-01'],
        [4, '2026-03-01'],
      ] as const) {
        await rec.timed(`open Details for passenger ${row}`, () => main.getByRole('button', { name: `Details for passenger ${row}` }).click(), () => expect(drawer).toBeVisible({ timeout: 30_000 }));
        rec.facts[`drawer:${row}`] = {
          type: await drawer.locator('#pax-type').inputValue().catch(() => null),
          ageFieldShown: (await drawer.getByLabel('Age at travel').count()) > 0,
          dobFieldShown: (await drawer.getByLabel('Date of birth').count()) > 0,
          privateLockedText: (await drawer.getByText('Save the passenger first to add these details.').count()) > 0,
        };
        await drawer.getByLabel('Date of birth').fill(dob);
        await rec.timed(`Save passenger ${row} with date of birth → drawer closes`, () => drawer.getByRole('button', { name: 'Save passenger' }).click(), () => expect(drawer).toBeHidden({ timeout: 30_000 }));
      }
    });

    await rec.run(page, '05 ID proof: saved traveller (adult 1), two files', () => attachProof(rec, page, names[0]!, 'adult1', false));

    await rec.run(page, '06 ID proof: unsaved traveller (adult 2 typed, Attach pressed at once), two files', async () => {
      const box = main.getByLabel('Passenger 2 full name');
      await box.pressSequentially(names[1]!, { delay: 15 });
      await attachProof(rec, page, names[1]!, 'adult2', true);
    });

    await rec.run(page, '07 edit a saved name rapidly', async () => {
      const box = main.getByLabel('Passenger 1 full name');
      await rec.timed(
        'append to passenger 1 name → footer settles',
        async () => {
          await box.press('End');
          await box.pressSequentially(' Edited', { delay: 15 });
        },
        () => footerSettled(page),
        () => footerSaving(page),
      );
      names[0] = `${names[0]!} Edited`;
    });

    await rec.run(page, '08 customer messages: Save message settings twice, reload', async () => {
      const card = page.locator('#book-message-prefs');
      rec.facts.messageCardShown = (await card.count()) > 0;
      if (!rec.facts.messageCardShown) throw new Error('Messages to the customer card not on step 1');
      const same = card.getByLabel('WhatsApp number is the same as mobile');
      if (await same.isChecked()) await same.uncheck();
      await card.getByLabel('WhatsApp number', { exact: true }).fill(WHATSAPP);
      await saveMessageSettings(rec, page, 'first save');
      await saveMessageSettings(rec, page, 'second save, no change');
      await card.getByLabel('WhatsApp number is the same as mobile').check();
      await saveMessageSettings(rec, page, 'third save, back to same as mobile');
      await rec.timed('reload step 1', () => page.reload(), () => expect(main.getByLabel('Name', { exact: true })).toBeVisible({ timeout: 30_000 }));
      rec.facts.messagePrefsAfterReload = {
        sameAsMobileTicked: await page.locator('#book-message-prefs').getByLabel('WhatsApp number is the same as mobile').isChecked().catch(() => null),
        db: (await dbSnapshot(deal.id)).messagePrefs,
      };
    });

    await rec.run(page, '09 step 2: add hotel, edit hotel', async () => {
      await rec.timed('Go to step 2', () => main.getByRole('button', { name: 'Go to step 2' }).click(), () => expect(page).toHaveURL(/\/book\/stay/, { timeout: 30_000 }));
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Hotels/ }).click();
      await main.getByRole('button', { name: 'Add hotel', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Add hotel stay' });
      await d.getByLabel('City').pressSequentially('Jodhpur', { delay: 15 });
      await d.getByLabel('Hotel', { exact: true }).pressSequentially('Synthetic Fort View Hotel', { delay: 15 });
      await d.getByLabel('Check-in').fill(TRIP.start);
      await d.getByLabel('Nights').fill(TRIP.nights);
      await d.getByLabel('Rooms: our cost per night').fill('9000');
      await rec.timed('Save hotel (new) → dialog closes', () => d.getByRole('button', { name: 'Save hotel' }).click(), () => expect(d).toBeHidden({ timeout: 30_000 }));
      await expect(main).toContainText('Synthetic Fort View Hotel', { timeout: 30_000 });
      await main.getByRole('button', { name: /^Edit hotel/ }).first().click();
      const e = page.getByRole('dialog', { name: 'Edit hotel stay' });
      await e.getByLabel('Rooms: our cost per night').fill('9500');
      await e.getByLabel('Hotel', { exact: true }).pressSequentially(' Annexe', { delay: 15 });
      await rec.timed('Save hotel (edit) → dialog closes', () => e.getByRole('button', { name: 'Save hotel' }).click(), () => expect(e).toBeHidden({ timeout: 30_000 }));
    });

    await rec.run(page, '10 step 2: second service (car, full trip)', async () => {
      await main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Cars/ }).click();
      await main.getByRole('button', { name: 'Add car', exact: true }).click();
      const car = page.getByRole('dialog', { name: 'Add car' });
      await car.getByRole('radio', { name: 'Full trip' }).click();
      await car.getByLabel('Vehicle', { exact: true }).selectOption('Innova');
      await car.getByLabel('Number of vehicles').fill('1');
      await car.getByLabel(/Rate per vehicle/).fill('12000');
      await car.getByLabel('Route', { exact: true }).fill('Jodhpur sightseeing');
      await car.getByLabel('Tour start').fill(TRIP.start);
      await car.getByLabel('Tour end').fill(TRIP.end);
      await rec.timed('Save car → dialog closes', () => car.getByRole('button', { name: 'Save car' }).click(), () => expect(car).toBeHidden({ timeout: 30_000 }));
    });

    await rec.run(page, '11 step 2: passport applicants (choose two, then Cancel)', async () => {
      const chip = main.getByRole('group', { name: 'Choose services' }).getByRole('button', { name: /Passport/ });
      rec.facts.passportOffered = (await chip.count()) > 0;
      if (!rec.facts.passportOffered) return;
      await chip.click();
      await main.getByRole('button', { name: 'Add passport details', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Passport requirements' });
      await expect(d).toBeVisible({ timeout: 30_000 });
      const group = d.getByRole('group', { name: /Applicant/ });
      await group.getByRole('button', { name: names[0]! }).click();
      await group.getByRole('button', { name: names[1]! }).click();
      rec.facts.passportApplicants = {
        pressedAfterChoosingTwo: await group.locator('button[aria-pressed="true"]').allTextContents(),
        whoLine: await d.locator('#svc-who-line').textContent().catch(() => null),
      };
      await rec.shot(page, 'passport-applicants');
      await d.getByRole('button', { name: 'Cancel' }).click();
      await expect(d).toBeHidden({ timeout: 30_000 });
      // Leave the empty passport section unchosen so it does not change what is submitted.
      if (await main.getByRole('button', { name: 'Add passport details', exact: true }).count()) await chip.click().catch(() => undefined);
    });

    await rec.run(page, '12 move between steps and back', async () => {
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'step 2 → step 1');
      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 1 → step 3');
      await gotoStep(rec, page, /Trip & services/, /\/book\/stay/, 'step 3 → step 2');
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'step 2 → step 1');
      await expect(main.getByLabel('Passenger 1 full name')).toHaveValue(names[0]!, { timeout: 30_000 });
      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'step 1 → step 3 (again)');
    });

    let totalRupees = 0;
    await rec.run(page, '13 step 3: package price', async () => {
      const price = main.locator('section#price');
      await price.getByLabel('Adult purchase per person, rupees').fill('20000');
      await price.getByLabel('Adult markup per person, rupees').fill('2000');
      const childBed = price.getByLabel('Child with bed: people');
      if (await childBed.count()) {
        await childBed.fill('1');
        await price.getByLabel('Child with bed purchase per person, rupees').fill('10000');
        await price.getByLabel('Child with bed markup per person, rupees').fill('1000');
      }
      const infant = price.getByLabel('Infant purchase per person, rupees');
      if (await infant.count()) {
        await infant.fill('0');
        await price.getByLabel('Infant markup per person, rupees').fill('0');
      }
      await rec.timed('price card saved', async () => undefined, () => pillIs(page, 'pill-price', /^saved$/, 30_000));
      const paise = await db(async (c) => (await c.query<{ t: string | null }>(`select c.selling_total_paise::text as t from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'draft'`, [deal.id])).rows[0]?.t ?? null);
      totalRupees = paise ? Number(paise) / 100 : 0;
      rec.facts.sellingTotalRupees = totalRupees;
    });

    await rec.run(page, '14 step 3: Bill To from the booking contact', async () => {
      const bill = main.locator('section#billTo');
      await bill.getByRole('button', { name: 'Type the details instead' }).click();
      await bill.getByRole('button', { name: 'Use booking contact' }).click();
      await bill.getByLabel('Address', { exact: true }).pressSequentially('1 Synthetic Lane', { delay: 15 });
      await bill.getByLabel('City').fill('Jodhpur');
      await bill.getByLabel('State').selectOption('08');
      await rec.timed('PIN typed → Bill To saved', () => bill.getByLabel('PIN code').fill('342001'), () => pillIs(page, 'pill-billTo', /^saved$/, 30_000), () => pillIs(page, 'pill-billTo', /saving|saved/, 10_000));
    });

    await rec.run(page, '15 step 3: payment plan equal to the total', async () => {
      const plan = main.locator('section#plan');
      await plan.getByRole('button', { name: 'Add instalment' }).click();
      await plan.getByLabel('Instalment 1', { exact: true }).fill('Full payment');
      await plan.locator('#payment-1-amount').fill(String(totalRupees || 55000));
      await rec.timed('due date typed → plan saved', () => plan.locator('#payment-1-due').fill(istToday()), () => pillIs(page, 'pill-plan', /^saved$/, 30_000), () => pillIs(page, 'pill-plan', /saving|saved/, 10_000));
      rec.facts.planText = ((await plan.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 300);
    });

    await rec.run(page, '16 step 3: acceptance evidence', async () => {
      await rec.timed(
        'choose acceptance file → shown as attached',
        () => page.getByLabel('Acceptance file').setInputFiles({ name: 'synthetic-acceptance.pdf', mimeType: 'application/pdf', buffer: syntheticPdf(`Synthetic acceptance ${tag}`) }),
        () => expect(page.locator('section#ok')).toContainText('synthetic-acceptance.pdf', { timeout: 30_000 }),
      );
      rec.facts.readyBeforeIdle = ((await page.locator('#bf-ready').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
      await rec.shot(page, 'ready-before-idle');
    });

    await rec.run(page, '17 idle (up to 6 minutes) with the page open', async () => {
      // Keep 2.5 minutes of the 10-minute test for the edits, Submit and checks after the idle.
      const idle = Math.max(60_000, Math.min(IDLE_MS, 10 * 60_000 - (Date.now() - testStart) - 150_000));
      rec.facts.idlePlannedMs = IDLE_MS;
      rec.facts.idleActualMs = idle;
      const end = Date.now() + idle;
      let minute = 0;
      while (Date.now() < end) {
        await page.waitForTimeout(Math.min(60_000, end - Date.now()));
        minute += 1;
        await rec.surfaces(page, `during idle minute ${minute}`);
      }
      rec.facts.footerAfterIdle = await footerText(page);
    });

    await rec.run(page, '18 keep editing after the idle', async () => {
      await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'after idle: step 3 → step 1');
      const box = main.getByLabel('Passenger 2 full name');
      await rec.timed(
        'after idle: edit passenger 2 name → footer settles',
        async () => {
          await box.press('End');
          await box.pressSequentially(' Later', { delay: 15 });
        },
        () => footerSettled(page),
        () => footerSaving(page),
      );
      names[1] = `${names[1]!} Later`;
      if (await page.locator('#book-message-prefs').count()) await saveMessageSettings(rec, page, 'after idle');
      await gotoStep(rec, page, /Trip & services/, /\/book\/stay/, 'after idle: step 1 → step 2');
      await main.getByRole('button', { name: /^Edit hotel/ }).first().click();
      const e = page.getByRole('dialog', { name: 'Edit hotel stay' });
      await e.getByLabel('Rooms: our cost per night').fill('9600');
      await rec.timed('after idle: Save hotel (edit) → dialog closes', () => e.getByRole('button', { name: 'Save hotel' }).click(), () => expect(e).toBeHidden({ timeout: 30_000 }));
      await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'after idle: step 2 → step 3');
      const paise = await db(async (c) => (await c.query<{ t: string | null }>(`select c.selling_total_paise::text as t from public.booking_version_commercials c join public.booking_versions v on v.id = c.version_id where v.deal_id = $1 and v.status = 'draft'`, [deal.id])).rows[0]?.t ?? null);
      rec.facts.sellingTotalAfterIdle = paise ? Number(paise) / 100 : null;
      rec.facts.readyAfterIdle = ((await page.locator('#bf-ready').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300);
    });

    await rec.run(
      page,
      '18b finish what readiness still asks, as staff would (ages, ID proofs)',
      async () => {
        const ready = page.locator('#bf-ready');
        const before = ((await ready.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
        rec.facts.readinessBeforeFix = before.slice(0, 600);
        await gotoStep(rec, page, /Customer & passengers/, /\/book\/travellers/, 'readiness fix: step 3 → step 1');
        rec.facts.rowsBeforeFix = await rowValues(page);
        const drawer = page.getByRole('dialog', { name: 'Passenger details' });
        const types = await main.locator('ol[aria-label="Passengers"] > li').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ')));
        const fixed: string[] = [];
        if (/age of every child and infant/i.test(before)) {
          for (const [i, text] of types.entries()) {
            const age = /Infant/.test(text) ? '0' : /Child/.test(text) ? '8' : null;
            if (age === null) continue;
            await main.getByRole('button', { name: `Details for passenger ${i + 1}` }).click();
            await expect(drawer).toBeVisible({ timeout: 30_000 });
            await drawer.getByLabel('Age at travel').fill(age);
            await rec.timed(`Save passenger ${i + 1} with age ${age} → drawer closes`, () => drawer.getByRole('button', { name: 'Save passenger' }).click(), () => expect(drawer).toBeHidden({ timeout: 30_000 }));
            fixed.push(`age ${age} for passenger ${i + 1}`);
          }
        }
        const rows = await rowValues(page);
        for (const [i, text] of types.entries()) {
          if (!/ID proof needed/.test(text) || !rows[i]) continue;
          await attachProof(rec, page, rows[i]!, `fix${i + 1}`, false);
          fixed.push(`ID proof again for passenger ${i + 1}`);
        }
        rec.facts.readinessFixes = fixed;
        await gotoStep(rec, page, /Price & Bill To/, /\/book\/finish/, 'readiness fix: step 1 → step 3');
        rec.facts.readinessAfterFix = ((await ready.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 600);
      },
      { always: true },
    );
    rec.resume();

    let submitted = false;
    await rec.run(page, '19 submit once', async () => {
      await main.getByRole('button', { name: 'Review and submit' }).click();
      const trigger = main.getByRole('region', { name: 'Submit' }).getByRole('button', { name: SUBMIT_BUTTON });
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      rec.facts.submitDisabled = (await trigger.getAttribute('aria-disabled')) ?? (await trigger.isDisabled() ? 'disabled' : null);
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: SUBMIT_DIALOG });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      rec.facts.submitDialog = ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 400);
      await rec.timed(
        'Submit booking and create tasks → Submitted page',
        () => dialog.getByRole('button', { name: SUBMIT_BUTTON }).click(),
        async () => {
          await expect(page).toHaveURL(new RegExp(`/app/deals/${deal.id}/book$`), { timeout: 30_000 });
          await expect(main).toContainText(/Submitted/, { timeout: 30_000 });
        },
        () => expect(dialog.getByRole('button', { name: /Submitting|Submit booking/ })).toBeDisabled({ timeout: 10_000 }),
      );
      submitted = true;
      await rec.shot(page, 'submitted');
    });

    await rec.run(page, '20 verify persisted booking, tasks, Accounts queue; reload', async () => {
      rec.facts.dbAfterSubmit = await dbSnapshot(deal.id);
      await rec.timed('reload the booking overview', () => page.reload(), () => expect(main).toContainText(/Submitted|Booking/, { timeout: 30_000 }));
      rec.facts.overviewAfterReload = ((await main.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 600);
      rec.facts.submittedVisibleAfterReload = (await main.getByText(/Submitted/).count()) > 0;
    });

    rec.facts.reachedPersistedSubmit = submitted && JSON.stringify(rec.facts.dbAfterSubmit ?? {}).includes('"confirmed"');
    await rec.save();
    await context.close();
  });

  test('(f) A1-05 candidate: passenger 2 typed while passenger 1 save is in flight; requests per autosave @investigation', async ({ browser }, testInfo) => {
    test.setTimeout(6 * 60_000);
    const rec = new Recorder('f-inflight-passengers', testInfo);
    await loadFixture(testInfo);
    const deal = await newDeal(String(Date.now()).slice(-8), 'Synthetic in-flight passengers');
    const { context, page } = await newSalesContext(browser, rec, 'sales');
    const main = page.locator('main');
    await rec.run(page, 'setup: start, customer card with 3 adults', async () => {
      await startBooking(rec, page, deal.id);
      await fillCustomer(rec, page, { adults: '3', children: '0', infants: '0' });
      await footerSettled(page);
      await sleep(1_500);
    });
    await rec.run(page, 'requests fired by ONE passenger-field autosave (normal network)', async () => {
      const from = rec.requests.length;
      const t = rec.now();
      await nameRow(rec, page, 3, 'Synthetic Count Adult Three', deal.id, 1);
      await footerSettled(page);
      await sleep(2_000);
      const mine = rec.requests.slice(from).filter((r) => r.startedAtMs >= t);
      rec.facts.rowsAfterTypingRow3Only = await rowValues(page);
      rec.facts.requestsPerSinglePassengerAutosave = {
        serverActionPosts: mine.filter((r) => r.kind === 'server-action').length,
        rscRefreshGets: mine.filter((r) => r.kind === 'rsc').length,
        other: mine.filter((r) => r.kind !== 'server-action' && r.kind !== 'rsc').map((r) => `${r.method} ${r.path}`),
        detail: mine.map((r) => ({ kind: r.kind, method: r.method, path: r.path, actionId: r.actionId, status: r.status, ms: r.ms })),
      };
    });
    let delayOn = false;
    await page.route('**/*', async (route) => {
      const r = route.request();
      if (delayOn && r.method() === 'POST' && r.headers()['next-action']) await sleep(2_500);
      await route.continue().catch(() => undefined);
    });
    await rec.run(page, 'passenger 1 saving (response held 2.5 s) while passenger 2 is typed', async () => {
      delayOn = true;
      const from = rec.requests.length;
      await main.getByLabel('Passenger 1 full name').pressSequentially('Synthetic Flight Adult One', { delay: 15 });
      // Wait until passenger 1's save is on the wire (debounce about 700 ms), then type passenger 2.
      await until(async () => rec.requests.length > from || /Saving/.test(await footerText(page)), 5_000, 'passenger 1 save started').catch(() => undefined);
      await sleep(300);
      await main.getByLabel('Passenger 2 full name').pressSequentially('Synthetic Flight Adult Two', { delay: 15 });
      await footerSettled(page, 30_000).catch((e: unknown) => rec.problem('not-settled', String(e).slice(0, 200), page.url()));
      await sleep(3_000);
      const texts = (await main.locator('[role="alert"], [role="status"], [id$="-error"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      rec.facts.afterInflight = {
        footer: await footerText(page),
        pill: await pillState(page, 'pill-passengers'),
        refusalSeen: texts.filter((x) => /named passenger is missing|missing from this save|Someone changed the passengers|Reload the page/i.test(x)),
        allAlertTexts: texts.slice(0, 15),
        db: (await dbSnapshot(deal.id)).travellers,
      };
      await rec.shot(page, 'after-inflight');
    });
    await rec.run(
      page,
      'refusal shown: what Reload does (with the delay off), then type back what is missing',
      async () => {
        delayOn = false;
        if ((await refusalOnScreen(page)).length === 0 && (await pillState(page, 'pill-passengers')) !== 'fix') return;
        await reloadAfterRefusal(rec, page, deal.id, ['Synthetic Flight Adult One', 'Synthetic Flight Adult Two', 'Synthetic Count Adult Three']);
        rec.resume();
      },
      { always: true },
    );
    await rec.run(page, 'delay off: does the refusal persist after 10 s and one more edit?', async () => {
      delayOn = false;
      await sleep(10_000);
      await main.getByLabel('Passenger 2 full name').press('End');
      await main.getByLabel('Passenger 2 full name').pressSequentially(' X', { delay: 15 });
      await footerSettled(page, 30_000).catch(() => undefined);
      await sleep(2_000);
      const texts = (await main.locator('[role="alert"], [role="status"], [id$="-error"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      rec.facts.afterRetry = {
        footer: await footerText(page),
        pill: await pillState(page, 'pill-passengers'),
        refusalSeen: texts.filter((x) => /named passenger is missing|missing from this save|Someone changed the passengers|Reload the page/i.test(x)),
        db: (await dbSnapshot(deal.id)).travellers,
      };
      await rec.shot(page, 'after-retry');
    });
    await page.unroute('**/*');
    await rec.save();
    await context.close();
  });

});
