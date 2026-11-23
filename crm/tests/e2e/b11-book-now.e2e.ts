import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open } from './b11-helpers';

/**
 * B1.1 Book now: the Deal page card, the landing and the loading and
 * not-available pages, through the design preview states (synthetic props;
 * stand-in actions that read and write nothing). Visual and interaction
 * evidence only; the real journey is b11-journey.real.e2e.ts on a local real
 * stack. The October step screen and its cases were removed on 17 November
 * 2026 (owner decision D2); the booking form is covered by bookform.e2e.ts.
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

test.describe('B1.1 Book now: page states', () => {
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
