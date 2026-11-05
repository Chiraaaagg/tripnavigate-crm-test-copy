import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';

/**
 * B1 Home "My work" counts and the Deals list "Services sold" / "Progress"
 * columns, through the design preview states (synthetic props).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const HOME_STATES = ['home-my-work-sales', 'home-my-work-accounts', 'home-my-work-purchase', 'home-my-work-unavailable'];
const DEALS_STATES = ['deals-list-progress', 'deals-list-progress-unavailable'];

async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

async function noHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  expect(response?.status(), state).toBe(200);
}

test.describe('B1 Home and Deals list: accessibility', () => {
  for (const state of [...HOME_STATES, ...DEALS_STATES]) {
    test(`axe clean at 1440 and 390; one h1; no sideways scroll at 390, 320 and 200% zoom: ${state}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      for (const size of [
        { width: 390, height: 844 },
        { width: 320, height: 800 },
        { width: 640, height: 400 },
      ]) {
        await page.setViewportSize(size);
        await open(page, state);
        await noHorizontalScroll(page);
        expect(await axe(page), `${state} at ${size.width}`).toEqual([]);
      }
    });
  }
});

// Direction A R0 (19 October 2026): the B1 "My work" counts are shown as Home "What needs you"
// rows (one button each), only for the roles they apply to (plan T4).
const needs = (page: Page) => page.getByRole('region', { name: 'What needs you', exact: true });
const rowLabels = (page: Page) => needs(page).locator('tbody tr td:first-child');
const rowCounts = (page: Page) => needs(page).locator('tbody tr td:nth-child(2)');

test.describe('B1 Home: What needs you (the My work counts)', () => {
  test('Sales sees four rows after the deal counts, each with one button to an existing address', async ({ page }) => {
    await open(page, 'home-my-work-sales');
    await expect(rowLabels(page)).toHaveText([
      'Booking drafts you can continue',
      'Returned by Accounts (your deals)',
      'Booking drafts missing details (your deals)',
      'Confirmed deals needing a booking (your deals)',
    ]);
    await expect(rowCounts(page)).toHaveText(['3', '1', '2', '4']);
    await expect(needs(page).getByRole('link', { name: /^Open deals/ })).toHaveCount(4);
    for (const href of await needs(page).getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href')))) {
      expect(href).toBe('/app/deals');
    }
    const order = await page.evaluate(() => {
      const deals = document.getElementById('deals-heading');
      const mine = document.getElementById('needs-heading');
      return deals && mine ? Boolean(deals.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    });
    expect(order).toBe(true);
  });

  test('Accounts gets "Receipts to verify" and no Sales-only rows; Purchase gets only its own queue', async ({ page }) => {
    await open(page, 'home-my-work-accounts');
    await expect(rowLabels(page)).toContainText(['Receipts to verify (recorded by someone else)']);
    await expect(rowLabels(page)).not.toContainText(['Requests to approve']);
    await expect(needs(page)).not.toContainText('Returned by Accounts');
    await expect(needs(page)).not.toContainText('missing details');
    await open(page, 'home-my-work-purchase');
    await expect(rowLabels(page)).toHaveText(['Purchase tasks not taken yet, or yours in progress']);
    await expect(needs(page).getByRole('link', { name: /^Open Purchase tasks/ })).toHaveAttribute('href', '/app/purchase');
  });

  test('a failed read says counts are unavailable instead of showing zeros', async ({ page }) => {
    await open(page, 'home-my-work-unavailable');
    await expect(needs(page).getByRole('status')).toContainText('Counts unavailable. Reload; nothing is affected.');
    await expect(needs(page).locator('tbody tr')).toHaveCount(0);
    await expect(needs(page)).not.toContainText('Nothing waiting');
    await expect(needs(page)).not.toContainText('Nothing needs you');
    await expect(page.locator('main header')).not.toContainText('Nothing needs you');
  });
});

test.describe('B1 Deals list: services and progress', () => {
  test('two extra columns with chips and short progress words (Batch 1 DL-09); the full breakdown stays in Details', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'deals-list-progress');
    const table = page.getByRole('table', { name: '1–4 of 4 deals' });
    await expect(table.getByRole('columnheader')).toHaveText(['Reference', 'Customer and trip', 'Stage', 'Owner', 'Services', 'Progress', 'Details']);
    const rows = table.getByRole('row');
    await expect(rows.nth(1).getByRole('cell').filter({ hasText: /^1 of 4 confirmed$/ })).toHaveAttribute('data-label', 'Progress');
    // The frozen breakdown words are kept, on demand in the row's Details.
    await expect(rows.nth(1)).toContainText('1 of 4 confirmed · 1 in progress · 2 not started');
    await expect(rows.nth(2)).toContainText('4 planned');
    await expect(rows.nth(3)).toContainText('2 of 2 confirmed');
    await expect(rows.nth(3).getByRole('list', { name: 'Services sold' })).toContainText('×2');
    await expect(rows.nth(4)).toContainText('No services yet');
    await expect(rows.nth(1).locator('[data-slot="service-type-pill"]')).toHaveCount(4);
    await expect(page.getByRole('group', { name: 'Order of deals' })).toBeVisible();
  });

  test('phone: the new columns become labelled lines in each card', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'deals-list-progress');
    const firstRow = page.getByRole('table').getByRole('row').nth(1);
    await expect(firstRow.getByRole('cell').filter({ hasText: /^1 of 4 confirmed$/ })).toHaveAttribute('data-label', 'Progress');
    await noHorizontalScroll(page);
  });

  test('when the projection fails the columns are omitted and one notice line is shown', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'deals-list-progress-unavailable');
    const table = page.getByRole('table', { name: '1–4 of 4 deals' });
    await expect(table.getByRole('columnheader')).toHaveText(['Reference', 'Customer and trip', 'Stage', 'Owner', 'Details']);
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Services did not load. The deal list itself is fine.' })).toHaveCount(1);
    await expect(page.locator('main')).not.toContainText('No services yet');
  });
});
