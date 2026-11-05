import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * B1.1 Book now: the Deal page card and the form (three steps since B1.2), through the design
 * preview states (synthetic props; stand-in actions that read and write
 * nothing). Visual and interaction evidence only; the real journey is
 * b11-journey.real.e2e.ts on a local real stack.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const DEAL_STATES = [
  'b11-deal-not-started',
  'b11-deal-not-won',
  'b11-deal-draft',
  'b11-deal-submitted',
  'b11-deal-returned',
  'b11-deal-lost',
  'b11-deal-lost-after-submit',
  'b11-deal-read-only',
  'b11-deal-switch-off',
  'b11-deal-booking-unavailable',
];
const BOOK_STATES = [
  'b11-book-landing',
  'b11-book-landing-not-won',
  'b11-book-travellers',
  'b11-book-stay',
  'b11-book-finish',
  'b11-book-customer',
  'b11-book-trip',
  'b11-book-services',
  'b11-book-price',
  'b11-book-payment',
  'b11-book-review',
  'b11-book-customer-empty',
  'b11-book-customer-business',
  'b11-book-customer-billing-verified',
  'b11-book-customer-refused',
  'b11-book-trip-domestic',
  'b11-book-trip-international',
  'b11-book-trip-child',
  'b11-book-trip-refused',
  'b11-book-services-empty',
  'b11-book-services-package',
  'b11-book-services-passport',
  'b11-book-services-train-refused',
  'b11-book-services-add-hotel',
  'b11-book-services-limit',
  'b11-book-price-empty',
  'b11-book-price-mismatch',
  'b11-book-price-filled',
  'b11-book-payment-no-advance',
  'b11-book-payment-partial',
  'b11-book-payment-claim-refused',
  'b11-book-payment-plan-mismatch',
  'b11-book-review-blocked',
  'b11-book-review-not-won',
  'b11-book-review-ready',
  'b11-book-review-confirm-dialog',
  'b11-book-upload-failed',
  'b11-book-concurrent-edit',
  'b11-book-saved',
  'b11-book-read-only',
  'b11-book-deal-lost-draft',
  'b11-book-not-visible',
  'b11-book-unavailable',
  'b11-book-loading',
];

accessibilitySuite('B1.1 Book now: accessibility', [...DEAL_STATES, ...BOOK_STATES]);
cspSuite('B1.1 Book now: production style policy', [...DEAL_STATES, ...BOOK_STATES]);

test.describe('B1.1 Book now: Deal page card', () => {
  test('not started: one Book now button and the honest "preparation only" words', async ({ page }) => {
    await open(page, 'b11-deal-not-started');
    const card = page.getByRole('region', { name: 'Booking' });
    await expect(card.getByRole('button', { name: 'Book now' })).toHaveCount(1);
    await expect(card).toContainText('Starts the booking form. Nothing is booked or paid.');
    await open(page, 'b11-deal-not-won');
    await expect(page.getByRole('region', { name: 'Booking' })).toContainText('Waiting for Won - Payment Received in Bitrix. You can keep preparing.');
  });

  test('draft, submitted, returned and lost each lead to one next step', async ({ page }) => {
    await open(page, 'b11-deal-draft');
    await expect(page.getByRole('link', { name: 'Continue booking' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Booking' })).toContainText('Booking draft · 4 things to finish');
    await open(page, 'b11-deal-submitted');
    await expect(page.getByRole('link', { name: 'View booking' })).toBeVisible();
    await open(page, 'b11-deal-returned');
    await expect(page.getByRole('link', { name: 'Fix and send again' })).toBeVisible();
    await open(page, 'b11-deal-lost');
    await expect(page.getByRole('region', { name: 'Booking' }).getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Booking' })).toContainText('a booking cannot be started');
    await open(page, 'b11-deal-lost-after-submit');
    await expect(page.getByRole('region', { name: 'Booking' })).toContainText('This deal is lost or rejected in Bitrix. You can read the booking; you cannot change it.');
    await open(page, 'b11-deal-read-only');
    await expect(page.getByRole('region', { name: 'Booking' }).getByRole('button')).toHaveCount(0);
    await open(page, 'b11-deal-booking-unavailable');
    await expect(page.getByRole('region', { name: 'Booking', exact: true }).getByRole('alert')).toHaveText('The booking did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.');
    await expect(page.locator('main')).not.toContainText('Hotel booking');
    await open(page, 'b11-deal-switch-off');
    await expect(page.getByRole('region', { name: 'Booking', exact: true })).toHaveCount(0);
  });
});

test.describe('B1.1 Book now: structure', () => {
  test('status, stage, owner and next step at the top; the step list marks the current step in words', async ({ page }) => {
    await open(page, 'b11-book-customer');
    const main = page.locator('main');
    await expect(main).toContainText('Booking status: Draft · version 1');
    await expect(main).toContainText('Won - Payment Received · submission allowed');
    await expect(main).toContainText('Owner: You');
    await expect(main.locator('[data-slot="book-next"]')).toHaveText(/^Next: /);
    await pillsHaveIconAndWord(page);
    const nav = page.getByRole('navigation', { name: 'Booking form steps' }).first();
    await expect(nav.getByRole('link')).toHaveCount(3);
    await expect(nav.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(nav.locator('[aria-current="step"]')).toContainText('1. Customer & passengers');
    await expect(nav.getByRole('link', { name: /3\. Price & Bill To \(needs input\)/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /2\. Trip & services \(complete\)/ })).toBeVisible();
    await expect(main.getByRole('button', { name: /^Save and continue to step 2/ })).toHaveCount(1);
    await expect(main.getByRole('button', { name: 'Save customer details' })).toHaveCount(1);
    await expect(main.getByRole('button', { name: 'Save passengers' })).toHaveCount(1);
  });

  test('at 390 px the step list folds into "Step n of 3" with all steps behind a disclosure', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'b11-book-trip');
    const nav = page.getByRole('navigation', { name: 'Booking form steps' }).last();
    await expect(nav).toContainText('Step 2 of 3');
    await nav.locator('summary').click();
    await expect(nav.getByRole('link')).toHaveCount(3);
    await expect(nav.locator('[aria-current="step"]')).toContainText('Trip & services');
  });

  test('keyboard: fields follow the visual order and focus is visible', async ({ page }) => {
    await open(page, 'b11-book-customer-empty');
    const name = page.getByLabel('Booking contact name');
    await name.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/^Mobile number/)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/^Email/)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/I confirmed this mobile number or email/)).toBeFocused();
    const outline = await page.getByLabel(/^Email/).evaluate((el) => {
      (el as HTMLElement).focus();
      return getComputedStyle(el).outlineWidth;
    });
    expect(parseFloat(outline)).toBeGreaterThan(0);
  });

  test('loading announces once, hidden h1, no motion with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'b11-book-loading');
    await expect(page.locator('main').getByRole('status')).toHaveText('Loading the booking…');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Book now');
    expect(await page.locator('main [data-slot="skeleton"]').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('not available and unavailable say so honestly', async ({ page }) => {
    await open(page, 'b11-book-not-visible');
    await expect(page.locator('main')).toContainText('This booking is not available to you. It may not exist, or you may not have access.');
    await open(page, 'b11-book-unavailable');
    await expect(page.locator('main').getByRole('alert')).toContainText('Nothing was changed.');
  });
});

test.describe('B1.1 Book now: refusals keep typed work', () => {
  test('customer step: the refusal names the fields, links to them and keeps what was typed', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'b11-book-customer-refused');
    const alert = page.locator('main [data-slot="error-summary"]');
    await expect(alert).toBeVisible();
    await page.getByLabel('Booking contact name').fill('Synthetic Contact Z');
    await page.getByLabel(/^Mobile number/).fill('12345');
    await page.getByRole('button', { name: 'Save customer details' }).click();
    await expect(alert).toContainText('Check the fields marked below. What you typed is still here.');
    await expect(page.getByLabel('Booking contact name')).toHaveValue('Synthetic Contact Z');
    await expect(page.getByLabel(/^Mobile number/)).toHaveValue('12345');
    await expect(page.getByLabel(/^Mobile number/)).toHaveAttribute('aria-invalid', 'true');
    await alert.getByRole('link', { name: /Mobile number/ }).click();
    await expect(page.getByLabel(/^Mobile number/)).toBeFocused();
  });

  test('someone saved first: who and when, typed values kept, a way to load the latest', async ({ page }) => {
    await open(page, 'b11-book-concurrent-edit');
    const alert = page.locator('main [data-slot="error-summary"]');
    await expect(alert).toContainText('Not saved: Synthetic Manager Delhi changed this at');
    await expect(alert).toContainText('What you typed is still here.');
    await expect(alert.getByRole('link', { name: 'Load the latest version (replaces what you typed)' })).toBeVisible();
  });

  // Older step screens (preview gallery only since PR 35; Mercury: no copy work on dead code). Echo-B L7: the live
  // reassurance (B0-14) is "Starts the booking form. Nothing is booked or paid." at Start booking (this file :81,
  // deal-page.e2e, b11-journey.real) and the submit dialog; live section saves now say only "Saved.".
  test('older step screen (preview only): a successful save says nothing was booked or paid', async ({ page }) => {
    await open(page, 'b11-book-saved');
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'saved.' })).toContainText('Nothing has been booked or paid.');
  });
});

test.describe('B1.1 Book now: steps', () => {
  test('identity details are asked only for international flight, visa or passport travellers', async ({ page }) => {
    await open(page, 'b11-book-finish');
    await expect(page.locator('main')).toContainText('No date of birth, passport or ID details are asked');
    await expect(page.getByLabel('Date of birth')).toHaveCount(0);
    await open(page, 'b11-book-trip-international');
    await expect(page.getByRole('note').filter({ hasText: 'Private identity details' })).toBeVisible();
    await expect(page.getByLabel('Date of birth')).toHaveCount(3);
    await expect(page.getByLabel(/^Passport number/).first()).toHaveAccessibleDescription(/Later is fine/);
  });

  test('a child needs an age; adults are not asked', async ({ page }) => {
    await open(page, 'b11-book-trip-child');
    await expect(page.getByLabel('Age in years')).toHaveCount(1);
    await page.getByRole('button', { name: 'Add traveller' }).click();
    await expect(page.getByLabel('Age in years')).toHaveCount(1);
  });

  test('services: department per service, visa waits for the desk launch, Train is refused on the spot', async ({ page }) => {
    await open(page, 'b11-book-services-package');
    const main = page.locator('main');
    await expect(main).toContainText('Goes to: Visa & Passport desk');
    await expect(main).toContainText('waits for the Visa & Passport desk launch');
    // Batch 2: step 3 sections open from the section list (nothing here needs input, so all start closed).
    await main.getByRole('navigation', { name: 'Sections of step 3' }).getByRole('link', { name: /Cabs, flights and other services/ }).click();
    await expect(main.getByRole('group', { name: /Who takes part/ }).first()).toBeVisible();
    // aria-disabled (not disabled): it stays focusable and explains itself when pressed.
    await main.getByRole('button', { name: 'Train (deferred)' }).click({ force: true });
    await expect(main.getByRole('alert').filter({ hasText: 'Train is deferred' })).toContainText('Nothing was added.');
  });

  test('passport: one applicant per service', async ({ page }) => {
    await open(page, 'b11-book-services-passport');
    await expect(page.locator('main')).toContainText('Who takes part (one applicant per passport service)');
  });

  test('adding a hotel that the server refuses keeps the typed values and names the field', async ({ page }) => {
    await open(page, 'b11-book-services-add-hotel');
    const form = page.getByRole('form', { name: 'New hotel service' });
    await expect(form.locator('[data-slot="error-summary"]')).toContainText('Check-out');
    await form.getByLabel('Requested hotel').fill('Sample Garden Hotel');
    await form.getByRole('button', { name: 'Add this hotel' }).click();
    await expect(form.getByLabel('Requested hotel')).toHaveValue('Sample Garden Hotel');
    await expect(form.getByLabel('Check-out')).toHaveAttribute('aria-invalid', 'true');
  });

  test('the 20-service limit is said, not hidden', async ({ page }) => {
    await open(page, 'b11-book-services-limit');
    await expect(page.locator('main')).toContainText('More than 20 services on one Deal isn’t supported (hotels and other services together).');
  });

  test('selling price: the rule list − discount = total is checked while typing', async ({ page }) => {
    await open(page, 'b11-book-price-filled');
    const main = page.locator('main');
    await expect(main).toContainText('Purchase, Flight and the Visa & Passport desk never see it.');
    await main.getByRole('navigation', { name: 'Sections of step 3' }).getByRole('link', { name: /Selling price/ }).click();
    await page.getByLabel(/^Final selling total/).fill('100000');
    await expect(page.getByLabel(/^Final selling total/)).toHaveAccessibleDescription(/Final total must equal list price minus discount/);
  });

  test('payment plan: a running total in words, and a mismatch is blocking', async ({ page }) => {
    await open(page, 'b11-book-payment');
    await expect(page.locator('main')).toContainText('matches the total');
    await open(page, 'b11-book-payment-plan-mismatch');
    await expect(page.locator('main')).toContainText('less than the total by');
    await page.getByRole('button', { name: 'Add instalment' }).click();
    await expect(page.getByRole('group', { name: 'Instalment 3' })).toBeVisible();
  });

  test('reported payments: never money, the mode decides the fields', async ({ page }) => {
    await open(page, 'b11-book-payment-partial');
    const main = page.locator('main');
    await expect(main).toContainText('Reported by Sales. Not money until a receipt is recorded and checked by a second Accounts person.');
    await expect(main).toContainText('Reported, not checked yet');
    await main.getByRole('navigation', { name: 'Sections of step 3' }).getByRole('link', { name: /Payment plan/ }).click();
    await main.getByLabel('How they paid').selectOption('cheque');
    await expect(main.getByLabel('Cheque number')).toBeVisible();
    await expect(main.getByLabel('Reference or UTR')).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Send to Accounts' })).toBeVisible();
  });

  test('review: blockers link to their step and section; submit is disabled with the reason', async ({ page }) => {
    await open(page, 'b11-book-review-blocked');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: /Before you can submit/ })).toContainText('(7)');
    await expect(main.getByRole('link', { name: /Step 1 · Customer and billing/ }).first()).toHaveAttribute('href', '/preview/b11-book-travellers#customer');
    await expect(main.getByRole('link', { name: /Step 2 · Destinations and dates/ }).first()).toHaveAttribute('href', '/preview/b11-book-stay#trip');
    await expect(main.getByRole('link', { name: /Step 3 · Selling price/ }).first()).toHaveAttribute('href', '#price');
    const submit = main.getByRole('button', { name: 'Submit booking and create tasks' });
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await expect(submit).toHaveAccessibleDescription(/items still block submission/);
    await open(page, 'b11-book-review-not-won');
    await expect(page.locator('main').getByRole('button', { name: 'Submit booking and create tasks' })).toHaveAccessibleDescription(/Submission waits for the Bitrix stage/);
  });

  test('submit opens a dialog that says what will and will not happen; Escape returns focus', async ({ page }) => {
    await open(page, 'b11-book-review-ready');
    const trigger = page.locator('main').getByRole('button', { name: 'Submit booking and create tasks' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Submit this booking and create tasks?' });
    await expect(dialog).toContainText('It creates 4 internal tasks');
    await expect(dialog).toContainText('It does not book anything, pay anyone, contact the customer');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await open(page, 'b11-book-review-confirm-dialog');
    await expect(page.getByRole('dialog')).toContainText('waits for the Visa & Passport desk launch');
  });

  test('a failed upload stores nothing and says so', async ({ page }) => {
    await open(page, 'b11-book-upload-failed');
    await expect(page.locator('main')).toContainText('The upload did not finish. The file is not stored and the form is unchanged.');
    await expect(page.locator('main')).toContainText('Upload did not finish: not stored.');
  });

  test('read-only and lost drafts have no edit buttons', async ({ page }) => {
    await open(page, 'b11-book-read-only');
    await expect(page.locator('main').getByRole('button', { name: /Save/ })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('You can read this booking draft.');
    await open(page, 'b11-book-deal-lost-draft');
    await expect(page.locator('main')).toContainText('lost or rejected in Bitrix');
    await expect(page.locator('main').getByRole('button', { name: 'Submit booking and create tasks' })).toHaveAttribute('aria-disabled', 'true');
  });
});
