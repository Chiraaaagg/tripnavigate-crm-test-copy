import { expect, test, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, noHorizontalScroll, open } from './b11-helpers';

/**
 * The booking form (owner-approved preview of 22 October 2026) through the
 * design-preview states: synthetic view models and stand-in actions that read
 * and write nothing. Visual and interaction evidence only; the real journeys
 * (save, reload, submit on a disposable local stack) are the *.real.e2e.ts
 * suites.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const SCENARIOS = ['empty', 'owner', 'gaps', 'no-price', 'verified', 'legacy', 'read-only', 'auto'] as const;
const STEPS = ['travellers', 'stay', 'finish'] as const;
const STATES = SCENARIOS.flatMap((s) => STEPS.map((step) => `bookform-${s}--${step}`));
const CORE = ['bookform-owner--travellers', 'bookform-owner--stay', 'bookform-owner--finish', 'bookform-empty--travellers', 'bookform-no-price--finish', 'bookform-auto--travellers'];

accessibilitySuite('Booking form: accessibility', CORE);
cspSuite('Booking form: production style policy', STATES);

const main = (page: Page) => page.locator('main');

test.describe('Booking form steps', () => {
  test('three horizontal steps with the approved names; the current one is marked', async ({ page }) => {
    await open(page, 'bookform-owner--travellers');
    const steps = main(page).getByRole('navigation', { name: 'Booking steps' });
    for (const name of [/Customer & passengers/, /Trip & services/, /Price & Bill To/]) await expect(steps.getByRole('button', { name })).toBeVisible();
    await expect(steps.getByRole('button', { name: /Customer & passengers/ })).toHaveAttribute('aria-current', 'step');
  });

  test('moving between steps keeps typed entries and follows the address; an incomplete card is not saved (D1)', async ({ page }) => {
    await open(page, 'bookform-empty--travellers');
    const destination = page.getByLabel('Destination', { exact: true });
    await destination.fill('Synthetic Kerala');
    await main(page).getByRole('navigation', { name: 'Booking steps' }).getByRole('button', { name: /Trip & services/ }).click();
    await expect(page).toHaveURL(/bookform-empty--stay$/);
    await expect(main(page).getByRole('group', { name: 'Choose services' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/bookform-empty--travellers$/);
    await expect(destination).toHaveValue('Synthetic Kerala');
    // Book now v2 (change 2, ruling D1): the card saves itself only when every check passes.
    await expect(page.locator('#pill-customer')).toHaveAttribute('data-state', 'fix');
    await expect(main(page)).toContainText(/Not saved: Customer & trip/);
  });

  test('the adult, child and infant steppers set the passenger rows (Book now v2: no total box)', async ({ page }) => {
    await open(page, 'bookform-empty--travellers');
    await expect(page.getByLabel('Total passengers')).toHaveCount(0);
    await page.getByRole('spinbutton', { name: 'Adults' }).fill('2');
    await page.getByRole('spinbutton', { name: 'Children' }).fill('1');
    await expect(main(page).locator('#bf-pax-total')).toContainText('Total: 3.');
    const pax = main(page).locator('section#passengers');
    await expect(pax.getByRole('textbox', { name: /^Passenger \d full name$/ })).toHaveCount(3);
    await expect(pax.getByLabel('Passenger 3 full name')).toHaveAttribute('placeholder', 'Child · full name');
  });

  test('automatic filling off: no Bitrix markers and no Bitrix buttons', async ({ page }) => {
    await open(page, 'bookform-empty--travellers');
    await expect(main(page)).not.toContainText('From Bitrix');
    await expect(main(page).getByRole('button', { name: /Use it|Use Bitrix|Keep mine/ })).toHaveCount(0);
  });

  test('automatic filling on: passive markers only, never "Use it" or "Keep mine"', async ({ page }) => {
    await open(page, 'bookform-auto--travellers');
    await expect(main(page).getByRole('button', { name: /Use it|Keep mine/ })).toHaveCount(0);
    await expect(main(page)).toContainText('From Bitrix');
    await expect(main(page)).not.toContainText('Details are entered by hand.');
  });

  test('ids are unique across all three mounted steps', async ({ page }) => {
    await open(page, 'bookform-owner--finish');
    const dupes = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(dupes).toEqual([]);
  });
});

test.describe('Booking form errors and links (Echo review B)', () => {
  test('the trip type is never silently Domestic: empty until chosen; the footer moves on without blocking (Book now v2)', async ({ page }) => {
    await open(page, 'bookform-empty--travellers');
    await expect(page.getByLabel('Trip', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Go to step 2' }).click();
    await expect(page).toHaveURL(/bookform-empty--stay$/);
    // The step tab still says step 1 needs details.
    await expect(main(page).getByRole('navigation', { name: 'Booking steps' }).getByRole('button', { name: /Customer & passengers \(needs details\)/ })).toBeVisible();
  });

  test('a refused save keeps what was typed and names the field under the card (change 2)', async ({ page }) => {
    await open(page, 'bookform-refused--travellers');
    const card = main(page).locator('section#customer');
    await card.getByLabel('Destination', { exact: true }).fill('Synthetic Goa');
    await expect(page.locator('#pill-customer')).toHaveAttribute('data-state', 'fix');
    await expect(card.getByLabel('Phone', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(card).toContainText('Mobile number: 10 digits starting with 6 to 9.');
    await expect(card.getByLabel('Destination', { exact: true })).toHaveValue('Synthetic Goa');
    await expect(main(page)).toContainText(/Not saved: Customer & trip/);
  });

  test('every item of "Before you submit" goes to a step of the form', async ({ page }) => {
    test.setTimeout(240_000);
    for (const scenario of ['gaps', 'empty', 'owner', 'no-price']) {
      await open(page, `bookform-${scenario}--finish`);
      const items = page.locator('#bf-ready').getByRole('button');
      await expect(items).toHaveCount(7);
      for (let i = 0; i < 7; i += 1) {
        await open(page, `bookform-${scenario}--finish`);
        await page.locator('#bf-ready').getByRole('button').nth(i).click();
        await expect(page, `${scenario}: item ${i + 1}`).toHaveURL(new RegExp(`bookform-${scenario}--(travellers|stay|finish)$`));
      }
    }
  });
});

test.describe('Booking form passengers and services', () => {
  test('compact passenger rows; Details opens the passenger drawer', async ({ page }) => {
    await open(page, 'bookform-owner--travellers');
    await expect(main(page).getByLabel('Passenger 1 full name')).toHaveValue('Sample Traveller A');
    await main(page).getByRole('button', { name: 'Details for passenger 1' }).click();
    const drawer = page.getByRole('dialog', { name: 'Passenger details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('Date of marriage')).toBeVisible();
    // Book now v2: ID proof is attached from the passenger row ("Attach ID proof"), not in this drawer.
    await expect(drawer.getByRole('group', { name: 'Private details' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    await expect(drawer).toBeHidden();
    await expect(main(page).getByRole('button', { name: 'Details for passenger 1' })).toBeFocused();
  });

  test('service cards show supplier cost only; the hotel editor works out the estimate', async ({ page }) => {
    await open(page, 'bookform-owner--stay');
    await expect(main(page)).toContainText('6 / 6 trip nights have a hotel');
    await expect(main(page)).toContainText('₹1,50,000');
    await main(page).getByRole('button', { name: 'Add hotel' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add hotel stay' });
    await drawer.getByLabel('Nights').fill('2');
    await drawer.getByLabel('Rooms: quantity').fill('2');
    await drawer.getByLabel('Rooms: our cost per night').fill('10000');
    await drawer.getByLabel('Extra beds: quantity').fill('2');
    await drawer.getByLabel('Extra beds: our cost per night').fill('2000');
    await drawer.getByLabel('No bed: quantity').fill('1');
    await drawer.getByLabel('No bed: our cost per night').fill('1000');
    await expect(drawer).toContainText('₹50,000');
    await expect(drawer).toContainText('An estimate only. It is not a price, a budget or a booking.');
    await expect(drawer.getByText(/Selling|Final sale/)).toHaveCount(0);
  });

  test('a missing hotel night is counted, not hidden by overlaps', async ({ page }) => {
    await open(page, 'bookform-gaps--stay');
    await expect(main(page).getByRole('status').filter({ hasText: /trip nights/ })).toContainText(/5 \/ 6 trip nights have a hotel ·\s*1 missing/);
  });

  test('a service with saved rows cannot be hidden', async ({ page }) => {
    await open(page, 'bookform-owner--stay');
    await main(page).getByRole('button', { name: /Hotels/, pressed: true }).click();
    await expect(main(page)).toContainText('Remove saved rows before hiding this service.');
    await expect(main(page).getByRole('button', { name: /Hotels/, pressed: true })).toBeVisible();
  });
});

test.describe('Booking form prices and Bill To', () => {
  test('price rows follow the party; the three edit directions keep the approved anchor', async ({ page }) => {
    await open(page, 'bookform-owner--finish');
    const table = main(page).locator('section#price');
    for (const name of ['Adult', 'Child with bed', 'Child without bed', 'Infant']) await expect(table.getByRole('group', { name })).toBeVisible();
    const purchase = table.getByLabel('Adult purchase per person, rupees');
    const markup = table.getByLabel('Adult markup per person, rupees');
    const sale = table.getByLabel('Adult final sale per person, rupees');
    await purchase.fill('12000');
    await expect(markup).toHaveValue('5000');
    await expect(sale).toHaveValue('17000.00');
    await markup.fill('2000');
    await expect(purchase).toHaveValue('12000');
    await expect(sale).toHaveValue('14000.00');
    await sale.fill('15000');
    await expect(purchase).toHaveValue('12000');
    await expect(markup).toHaveValue('3000.00');
    await sale.fill('9000');
    await expect(markup).toHaveValue('-3000.00');
    await expect(table).toContainText('Final sale is below purchase.');
  });

  test('only the adult row without children or infants; the total is "Not worked out yet" while amounts are missing', async ({ page }) => {
    await open(page, 'bookform-empty--finish');
    const table = main(page).locator('section#price');
    await expect(table.getByRole('group', { name: 'Adult' })).toBeVisible();
    await expect(table.getByRole('group', { name: 'Infant' })).toHaveCount(0);
    await expect(table.getByRole('group', { name: 'Child with bed' })).toHaveCount(0);
    await expect(table).toContainText('Not worked out yet');
  });

  test('no price access: one locked line, no amounts', async ({ page }) => {
    await open(page, 'bookform-no-price--finish');
    await expect(main(page)).toContainText('The selling price is not shown to you');
    await expect(main(page).locator('section#price input')).toHaveCount(0);
    await expect(main(page)).not.toContainText('₹44,600');
  });

  test('a refused price save keeps the typed amounts', async ({ page }) => {
    await open(page, 'bookform-refused--finish');
    const table = main(page).locator('section#price');
    await expect(table.getByRole('button', { name: 'Save prices' })).toHaveCount(0);
    await table.getByLabel('Adult final sale per person, rupees').fill('17000');
    // The card saves itself (change 2); the stand-in refuses it.
    await expect(page.locator('#pill-price')).toHaveAttribute('data-state', 'fix');
    await expect(table.getByLabel('Adult final sale per person, rupees')).toHaveValue('17000');
  });

  test('customer list: similar names stay apart, explicit selection fills Bill To, nothing is stored in the browser', async ({ page }) => {
    await open(page, 'bookform-empty--finish');
    const bill = main(page).locator('section#billTo');
    const list = [
      { id: 'SYN-001', type: 'personal', name: 'Riya Mehta', phone: '9876500001', address: '1 Sample Road', city: 'Jodhpur', state: 'Rajasthan', pin: '342001' },
      { id: 'SYN-002', type: 'business', name: 'Riya Mehta Travels', contact: 'Sample Contact', email: 'riya@example.com', gstStatus: 'unregistered', gstReason: 'Below the threshold for now', address: '2 Sample Road', city: 'Jaipur', state: 'Rajasthan', pin: '302001' },
    ];
    await bill.locator('input[type=file]').setInputFiles({ name: 'customers.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(list)) });
    await expect(bill).toContainText('2 customers opened in this tab only. Not uploaded.');
    await bill.getByRole('searchbox').fill('Riya');
    const results = bill.getByRole('group', { name: 'Matching clients' });
    await expect(results.getByRole('button')).toHaveCount(2);
    await results.getByRole('button', { name: /SYN-002/ }).click();
    await expect(bill.getByLabel('Company name')).toHaveValue('Riya Mehta Travels');
    await expect(bill).toContainText('Client selected · SYN-002');
    await expect(bill.getByLabel('GST registration')).toHaveValue('unregistered');
    await bill.getByLabel('Contact name').fill('Another Contact');
    await expect(bill).toContainText('Client details edited for this booking · SYN-002');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('Riya');
  });

  test('switching Personal and Business keeps the address; clicking the chosen type changes nothing', async ({ page }) => {
    await open(page, 'bookform-owner--finish');
    const bill = main(page).locator('section#billTo');
    await bill.getByRole('radio', { name: 'Business', checked: true }).click();
    await expect(bill.getByLabel('Company name')).toHaveValue('Sample Travels Pvt Ltd');
    await bill.getByRole('radio', { name: 'Personal' }).click();
    await expect(bill.getByLabel('Full name')).toHaveValue('');
    await expect(bill.getByLabel('Address', { exact: true })).toHaveValue('1 Sample Road');
  });

  test('Accounts-checked Bill To is locked with words', async ({ page }) => {
    await open(page, 'bookform-verified--finish');
    await expect(main(page)).toContainText('Billing checked by Accounts. Ask Accounts to change it.');
    await expect(main(page).locator('section#billTo input')).toHaveCount(0);
  });

  test('a legacy total stays as typed and no per-person prices are invented', async ({ page }) => {
    await open(page, 'bookform-legacy--finish');
    await expect(main(page)).toContainText('Total typed before per-person prices existed: ₹1,20,000. It stays as it is.');
    await expect(main(page).getByLabel('Adult purchase per person, rupees')).toHaveValue('');
  });

  test('"Before you submit" opens step 3 with the reason; an item opens the right step (change 9)', async ({ page }) => {
    await open(page, 'bookform-gaps--finish');
    const ready = page.locator('#bf-ready');
    await expect(ready.getByRole('button', { name: /Trip & services/ })).toContainText('5 of 6 trip nights have a hotel. Add a hotel for 28 Oct.');
    await ready.getByRole('button', { name: /Trip & services/ }).click();
    await expect(page).toHaveURL(/bookform-gaps--stay/);
    await expect(main(page).getByRole('group', { name: 'Choose services' })).toBeVisible();
  });
});

test.describe('Booking form phone widths', () => {
  for (const width of [320, 375]) {
    test(`no sideways scroll at ${width} px on every step`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      for (const step of STEPS) {
        const state = `bookform-owner--${step}`;
        await open(page, state);
        await noHorizontalScroll(page, `${state} at ${width}`);
      }
    });
  }
});
