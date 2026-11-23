import { expect, test, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';

/**
 * R3 approved-form exceptions on the Flight Work tab (owner, 16 November 2026;
 * design plan 2.4), on the preview gallery (synthetic, no database):
 *   O9  the tracker steps are jump links; a finished step folds to one line;
 *   O10 a sticky bar "2 flights selected · Confirm tickets" while flights are
 *       ticked and the Confirm tickets block is out of view.
 * No field, step, label, warning or rule changed.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  expect(response?.status(), state).toBe(200);
}

test.describe('R3 Flight Work tab (O9, O10)', () => {
  test('O9: the steps are jump links with their state in words', async ({ page }) => {
    await open(page, 'flight-ws-work');
    const nav = page.getByRole('navigation', { name: 'Flight steps on this page' });
    await expect(nav.getByRole('link', { name: /^Confirm tickets/ })).toHaveAttribute('href', '#confirm-tickets');
    await expect(nav.getByRole('link', { name: /^Cost|^Pay supplier/ })).toHaveAttribute('href', '#cost-payment');
    await expect(nav.getByRole('link', { name: /^Flight done/ })).toHaveAttribute('href', '#finish');
    await expect(nav.locator('[aria-current="step"]')).toHaveCount(1);
    await nav.getByRole('link', { name: /^Flight done/ }).click();
    await expect(page.locator('#finish')).toBeInViewport();
    // R3 integration: the shared JumpLinks moves focus to the block (O9 "jumps to and focuses").
    await expect(page.locator('#finish')).toBeFocused();
  });

  test('O9: the header shows the status and "Next:" only; the steps show once, on the Work tab', async ({ page }) => {
    await open(page, 'flight-ws-work');
    await expect(page.getByRole('region', { name: 'Flight progress' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Flight steps on this page' })).toHaveCount(1);
  });

  test('O6 from another tab: arriving on Work at #finish moves focus there', async ({ page }) => {
    await page.goto('/preview/flight-ws-work#finish');
    await expect(page.locator('#finish')).toBeFocused();
  });

  test('O9: nobody has taken the flights yet: no step links', async ({ page }) => {
    await open(page, 'flight-ws-not-taken');
    await expect(page.getByRole('navigation', { name: 'Flight steps on this page' })).toHaveCount(0);
  });

  test('O9: once every ticket is confirmed, the itinerary folds to one line and opens on request', async ({ page }) => {
    await open(page, 'flight-ws-done');
    const fold = page.locator('details#step-itinerary');
    await expect(fold.locator('summary')).toContainText('Itinerary and flight changes');
    await expect(fold.locator('summary')).toContainText('Confirm tickets: done');
    await expect(fold).not.toHaveAttribute('open', '');
    await fold.locator('summary').click();
    await expect(fold).toHaveAttribute('open', '');
    // Finish this flight never folds.
    await expect(page.locator('#finish')).toBeVisible();
  });

  test('O9: a step with work left never folds (invoice missing keeps Cost and payment open)', async ({ page }) => {
    await open(page, 'flight-ws-invoice-missing');
    await expect(page.locator('details#step-payment')).toHaveCount(0);
    await expect(page.getByText('Invoice missing').first()).toBeVisible();
  });

  test('O9: a decided flight change is one line; its details open below it', async ({ page }) => {
    await open(page, 'flight-ws-flight-only');
    const change = page.getByRole('list', { name: /^Flight changes of / }).locator('details').first();
    await expect(change.locator('summary')).toContainText('Change 1');
    await expect(change.getByText(/^Travellers:/)).toBeHidden();
    await change.locator('summary').click();
    await expect(change.getByText(/^Travellers:/)).toBeVisible();
  });

  test('O10: ticking a flight shows the sticky bar and announces the count; its button opens the same popup', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await open(page, 'flight-ws-work');
    await page.locator('#itinerary').scrollIntoViewIfNeeded();
    const bar = page.locator('[data-slot="selection-bar"]');
    await expect(bar).toHaveCount(0);
    await page.getByRole('checkbox', { name: /for Confirm tickets$/ }).first().check();
    await expect(page.getByRole('status').filter({ hasText: /^1 flight selected$/ })).toHaveCount(1);
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('1 flight selected');
    await bar.getByRole('button', { name: 'Confirm tickets' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    // Focus returns to the block's own Confirm tickets button, as before; the bar hides while that block is in view.
    await expect(page.locator('#confirm-tickets').getByRole('button', { name: /^Confirm tickets/ })).toBeFocused();
    await expect(bar).toHaveCount(0);
  });

  test('O10: under 200% zoom and at 390 px the bar fits without sideways scroll', async ({ page }) => {
    for (const size of [{ width: 390, height: 844 }, { width: 640, height: 450 }]) {
      await page.setViewportSize(size);
      await open(page, 'flight-ws-work');
      await page.getByRole('checkbox', { name: /for Confirm tickets$/ }).first().check();
      await page.evaluate(() => window.scrollTo(0, 0));
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw, `${size.width} px`).toBeLessThanOrEqual(cw);
    }
  });
});
