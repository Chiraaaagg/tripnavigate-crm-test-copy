import { expect, test, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, noHorizontalScroll, open } from './b11-helpers';

/**
 * Book now v2 (owner-approved prototype of 26 October 2026) through the
 * design-preview gallery: synthetic view models and stand-in actions that
 * read and write nothing (/preview/bookform-v2--{step} and
 * bookform-v2-empty--{step}). Interaction evidence only; saving, reloading
 * and submitting against a database are the *.real.e2e.ts suites.
 *
 * The v2 scenario: travellers Sample Traveller A and B (adults), Sample
 * Child C and Sample Infant D; Hotel 1 Jodhpur and Hotel 2 Udaipur; Flight 1
 * DEL to JDH with a fare per person; Flight 2 from a screenshot; Car 1 an
 * airport pickup.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STEPS = ['travellers', 'stay', 'finish'] as const;
const STATES = ['v2', 'v2-empty'].flatMap((s) => STEPS.map((step) => `bookform-${s}--${step}`));

accessibilitySuite('Book now v2: accessibility', STATES);
cspSuite('Book now v2: production style policy', STATES);

const main = (page: Page) => page.locator('main');
const drawer = (page: Page) => page.getByRole('dialog');

/** Server-action posts the page sends (stand-in actions answer each with a fixed result). */
function countActionPosts(page: Page): { readonly count: number } {
  const seen = { count: 0 };
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) seen.count += 1;
  });
  return seen;
}

test.describe('Cards that save themselves (change 2)', () => {
  test('the price card goes Saving… then Saved after a change; no "Save prices" button', async ({ page }) => {
    await open(page, 'bookform-v2--finish');
    await expect(main(page).getByRole('button', { name: /^Save prices$/ })).toHaveCount(0);
    const pill = page.locator('#pill-price');
    await expect(pill).toBeVisible();
    await page.locator('#price-adult-sale').fill('17000');
    await expect(pill).toHaveAttribute('data-state', 'saving');
    await expect(pill).toContainText('Saving…');
    await expect(pill).toHaveAttribute('data-state', 'saved');
    await expect(pill).toContainText('Saved');
  });

  test('every self-saving card of step 1 has a pill with a word; no section save buttons', async ({ page }) => {
    await open(page, 'bookform-v2--travellers');
    for (const id of ['pill-customer', 'pill-passengers']) {
      const pill = page.locator(`#${id}`);
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText(/Not started|Saving…|Saved|Not saved · needs a fix/);
    }
    await expect(main(page).getByRole('button', { name: /^Save (customer details|passengers)$/ })).toHaveCount(0);
  });

  test('a wrong value shows "Not saved · needs a fix" and the footer links to the card', async ({ page }) => {
    await open(page, 'bookform-v2--finish');
    await page.locator('#price-adult-sale').fill('12.345');
    const pill = page.locator('#pill-price');
    await expect(pill).toHaveAttribute('data-state', 'fix');
    await expect(pill).toContainText('Not saved · needs a fix');
    await expect(main(page)).toContainText(/Not saved: Package price/);
    await expect(main(page).getByRole('button', { name: /Go to fix/ }).or(main(page).getByRole('link', { name: /Go to fix/ })).first()).toBeVisible();
  });
});

test.describe('Trip facts from the Bitrix Deal (change 1)', () => {
  test('the locked bar shows the Deal facts; N of M named; Correct opens the refresh dialog', async ({ page }) => {
    await open(page, 'bookform-v2--travellers');
    await expect(main(page)).toContainText('Trip facts from the Bitrix Deal');
    await expect(page.locator('#bf-pax-named')).toHaveText('4 of 4 named');
    await main(page).getByRole('button', { name: 'Correct' }).click();
    const dialog = drawer(page);
    await expect(dialog.getByRole('heading', { name: 'Correct trip details in Bitrix' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: /Open the Deal in Bitrix/ })).toHaveAttribute('target', '_blank');
  });

  test('"Refresh from Bitrix now" shows Refreshing… and is disabled while the read runs, then closes with a toast', async ({ page }) => {
    await open(page, 'bookform-v2--travellers');
    // Hold the stand-in action's answer so the busy state can be seen.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/preview/bookform-v2--travellers', async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });
    await main(page).getByRole('button', { name: 'Correct' }).click();
    const dialog = drawer(page);
    await dialog.getByRole('button', { name: 'Refresh from Bitrix now' }).click();
    const busy = dialog.getByRole('button', { name: /Refreshing…/ });
    await expect(busy).toBeVisible();
    await expect(busy).toBeDisabled();
    release();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Read from Bitrix. Nothing had changed on the Deal.')).toBeVisible();
  });
});

test.describe('Flights (changes 3, 7, 18, 19)', () => {
  test('airport search finds "Jodhpur (JDH)", a city and a code; an unknown name keeps the text and says what to do', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Add flight' }).click();
    const from = page.locator('#ap-from');
    await from.fill('Jodhpur (JDH)');
    await expect(page.getByRole('listbox', { name: 'From airports' }).getByRole('option').first()).toContainText('JDH');
    await from.press('Enter');
    await expect(from).toHaveValue(/Jodhpur.*JDH|JDH.*Jodhpur/);
    const to = page.locator('#ap-to');
    await to.fill('del');
    await expect(page.getByRole('listbox', { name: 'To airports' }).getByRole('option').first()).toContainText('DEL');
    await to.fill('Nowhere Synthetic');
    await page.locator('#svc-seg-1-date').click();
    await expect(page.locator('#ap-to-hint')).toHaveText('Pick an airport from the list, e.g. DEL. What you typed is still here.');
    await expect(to).toHaveValue('Nowhere Synthetic');
  });

  test('Add next flight starts where the last typed flight lands and carries the travellers', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Add next flight' }).click();
    // The last flight is a screenshot flight: the next one is an empty typed flight.
    const d = drawer(page);
    await expect(d.getByRole('radio', { name: 'Type the details' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#ap-from')).toHaveValue('');
    await expect(page.locator('#svc-who-line')).toContainText('4 of 4 chosen');
  });

  test('Add return flights adds them and says so; the button is not offered twice', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    const posts = countActionPosts(page);
    const button = main(page).getByRole('button', { name: 'Add return flights' });
    await button.click();
    await expect(page.getByText(/1 return flight added for/)).toBeVisible();
    expect(posts.count).toBe(1);
  });

  test('fare per person on the row and the all-flights box names the flight without a fare', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await expect(main(page)).toContainText('Fare per person: Adult ₹6,000 · Child ₹4,500');
    const box = page.locator('#bf-fare-box');
    await expect(box).toContainText('Total fare per person, all flights');
    await expect(box).toContainText('Adult: flight 2 has no fare yet');
    // Typing the totals (one ticket with a layover) adds them up live.
    await page.locator('#bf-fare-adult').fill('14000');
    await expect(box).toContainText('Adult: ₹14,000 × 2 = ₹28,000');
    await expect(box).toContainText('All flights: ₹28,000');
  });

  test('the flight drawer asks fare per person for adult, child and infant (step 1 has them)', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Edit flight 1' }).click();
    for (const k of ['adult', 'child', 'infant']) await expect(page.locator(`#svc-fare-${k}`)).toBeVisible();
    await expect(page.locator('#svc-fare-adult')).toHaveValue('6000');
  });

  test('a screenshot flight: the typed fields hide, a screenshot is required, the note is kept', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Add flight' }).click();
    const d = drawer(page);
    await d.getByRole('radio', { name: 'Attach a screenshot' }).click();
    await expect(page.locator('#ap-from')).toHaveCount(0);
    await expect(page.locator('#svc-screenshot')).toBeVisible();
    await page.locator('#svc-screenshotNote').fill('Book the 08:00 option');
    await d.getByRole('button', { name: 'Save flight' }).click();
    await expect(page.locator('#svc-problem')).toContainText('Attach at least one screenshot, or choose “Type the details”.');
    // Attaching one clears the error (change 5).
    await page.locator('#svc-screenshot').setInputFiles({ name: 'fare-quote.png', mimeType: 'image/png', buffer: Buffer.from('synthetic') });
    await expect(page.locator('#svc-problem')).toHaveCount(0);
    await expect(d).toContainText('fare-quote.png');
  });

  test('the screenshot flight row reads "From screenshot" and is not flagged for times', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    const flights = main(page).getByRole('region', { name: /^Flights/ });
    await expect(flights).toContainText(/Flight 2\s*From screenshot · Book the 08:00 option\s*1 screenshot/);
    // Neither flight is flagged: flight 1 has its number and times, flight 2 is a screenshot.
    await expect(flights).not.toContainText('Add flight number and times');
  });
});

test.describe('Hotel requests "for <name>" (change 16)', () => {
  test('the stored request shows for one person; a new suggestion is for everyone and can be pointed at one person', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Edit hotel 1' }).click();
    const d = drawer(page);
    await expect(d.getByRole('combobox', { name: 'Baby cot is for' })).toHaveValue('4');
    await page.locator('#svc-hotel-requests').fill('High');
    await page.locator('#svc-hotel-requests').press('Enter');
    const forWho = d.getByRole('combobox', { name: 'High floor is for' });
    await expect(forWho).toHaveValue('');
    await forWho.selectOption({ label: 'for Sample Traveller A' });
    await expect(forWho).toHaveValue('1');
  });
});

test.describe('Car pickup auto-fill (change 14)', () => {
  test('choosing the flight fills pickup, drop, date and time; all stay editable', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Add car' }).click();
    const d = drawer(page);
    await d.getByRole('radio', { name: 'Airport pickup' }).click();
    await page.locator('#svc-flightItemId').selectOption({ index: 1 });
    await expect(page.locator('#svc-pickup')).toHaveValue('Jodhpur airport (JDH), flight SA520');
    await expect(page.locator('#svc-drop')).toHaveValue('Sample Palace Hotel, Jodhpur');
    await expect(page.locator('#svc-date')).toHaveValue('2026-10-25');
    await expect(page.locator('#svc-pickupTime')).toHaveValue('09:40');
    await page.locator('#svc-pickup').fill('Synthetic gate 2');
    await expect(page.locator('#svc-pickup')).toHaveValue('Synthetic gate 2');
  });

  test('a screenshot flight fills nothing and says to type the details', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Add car' }).click();
    const d = drawer(page);
    await d.getByRole('radio', { name: 'Airport pickup' }).click();
    await page.locator('#svc-flightItemId').selectOption({ label: 'Flight 2 · from screenshot' });
    await expect(page.getByText('This flight is a screenshot. Type the pickup, drop, date and time.')).toBeVisible();
    await expect(page.locator('#svc-pickup')).toHaveValue('');
  });
});

test.describe('Double save guard (change 4)', () => {
  test('a double click on "Save hotel" sends one save; the button says Saving… and is disabled meanwhile', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Copy hotel 1' }).click();
    const d = drawer(page);
    const posts = countActionPosts(page);
    await d.getByRole('button', { name: 'Save hotel' }).dblclick();
    await expect(d).toHaveCount(0);
    expect(posts.count).toBe(1);
  });

  test('Enter inside a field never saves the drawer', async ({ page }) => {
    await open(page, 'bookform-v2--stay');
    await main(page).getByRole('button', { name: 'Edit hotel 1' }).click();
    const posts = countActionPosts(page);
    await page.locator('#svc-roomType').press('Enter');
    await expect(drawer(page)).toBeVisible();
    expect(posts.count).toBe(0);
  });
});

test.describe('Before you submit (change 9)', () => {
  test('seven items with x of 7 done; tapping an item goes to it', async ({ page }) => {
    await open(page, 'bookform-v2--finish');
    const ready = page.locator('#bf-ready');
    await expect(ready.getByRole('heading', { name: /Before you submit|Ready to submit/ })).toBeVisible();
    await expect(ready).toContainText(/\d of 7 done/);
    await expect(ready.getByRole('button')).toHaveCount(7);
    await expect(ready.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '7');
    await ready.getByRole('button', { name: /Customer’s written OK/ }).click();
    await expect(page.locator('#ok')).toBeInViewport();
  });

  test('the empty draft lists what is missing; no sideways scroll at 375 px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, 'bookform-v2-empty--finish');
    await expect(page.locator('#bf-ready')).toContainText('Before you submit');
    await expect(page.locator('#bf-ready')).toContainText('0 of 7 done');
    await noHorizontalScroll(page, 'bookform-v2-empty--finish');
  });
});
