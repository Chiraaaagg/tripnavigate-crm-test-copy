import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 5B Milestone A UI repairs through the design-preview gallery
 * (synthetic props, no Supabase). §2 cash states and bounded unresolved
 * lists, §3 Accounts queue pages, §4 deal list pages. Not evidence of a real
 * journey; the database half lives in tests/db/finance-*.test.ts.
 */

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function open(page: Page, state: string) {
  await page.goto(`/preview/${state}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  await page.waitForLoadState('networkidle');
}

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

test.describe('Milestone A §2: cash states', () => {
  test('missing, awaiting verification and stale are distinct items; verified counts are listed apart', async ({ page }) => {
    await open(page, 'finance-cash');
    const delhi = page.getByRole('region', { name: 'Delhi' });
    const list = delhi.getByRole('list', { name: 'Unresolved cash work at Delhi' });
    const missing = list.getByRole('listitem').filter({ hasText: 'Daily cash count missing' });
    const awaiting = list.getByRole('listitem').filter({ hasText: 'Daily cash count awaiting verification' });
    const stale = list.getByRole('listitem').filter({ hasText: 'Verified cash count is out of date' });
    await expect(missing).toContainText('1 date · oldest 2 Nov 2026');
    await expect(awaiting).toContainText('the date is not cleared yet');
    await expect(stale).toContainText('Count again');
    await expect(delhi.getByText('6 unresolved')).toBeVisible();
  });

  test('a recorded but unverified count never reads as nothing unresolved', async ({ page }) => {
    await open(page, 'finance-cash-awaiting-verification');
    const branch = page.getByRole('region', { name: 'Jodhpur' });
    await expect(branch).not.toContainText('Nothing unresolved at this branch.');
    await expect(branch).not.toContainText('Up to date');
    await expect(branch).toContainText('Daily cash count awaiting verification');
    await expect(branch).toContainText('1 unresolved');
  });

  test('truncated lists say how many exist and the oldest date per kind', async ({ page }) => {
    await open(page, 'finance-cash-truncated');
    const branch = page.getByRole('region', { name: 'Jodhpur' });
    await expect(branch.getByRole('note').filter({ hasText: 'The counts below include every unresolved item' })).toBeVisible();
    const missing = branch.getByRole('listitem').filter({ hasText: 'Daily cash count missing' }).first();
    await expect(missing).toContainText('63 dates · oldest 3 Aug 2026');
    await expect(missing).toContainText('Showing the 50 oldest of 63.');
    await expect(branch.getByRole('list', { name: 'Daily cash count missing: listed items' }).getByRole('listitem')).toHaveCount(50);
    await expect(branch).toContainText('64 unresolved');
    await expect(branch).not.toContainText('Nothing unresolved at this branch.');
  });

  test('nothing unresolved only when every total is zero', async ({ page }) => {
    await open(page, 'finance-cash');
    await expect(page.getByRole('region', { name: 'Jodhpur' })).toContainText('Nothing unresolved at this branch.');
    await expect(page.getByRole('region', { name: 'Delhi' })).not.toContainText('Nothing unresolved at this branch.');
  });
});

test.describe('Milestone A §3: Accounts queue pages', () => {
  test('a partial page says "Showing N of TOTAL" and links to the next page keeping the filter', async ({ page }) => {
    await open(page, 'finance-queue-truncated');
    await expect(page.getByRole('status').filter({ hasText: 'Showing 4 of 137 deals under “All”' })).toBeVisible();
    await expect(page.getByRole('table')).toContainText('Showing 4 of 137 deals');
    const pager = page.getByRole('navigation', { name: 'Accounts queue pages' });
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      `/app/accounts?filter=all&after=${encodeURIComponent('d5000000-0000-4000-8000-000000000005:SYN-AMD-005')}`,
    );
    await expect(pager.getByRole('link', { name: 'First page' })).toHaveCount(0);
  });

  test('a later page offers the first page, keeps the filter and still shows the total', async ({ page }) => {
    await open(page, 'finance-queue-later-page');
    await expect(page.getByRole('table')).toContainText('Showing 2 of 52 deals · Booking reviews');
    const pager = page.getByRole('navigation', { name: 'Accounts queue pages' });
    // Booking reviews is the default tab (Batch 4, AC-01), so its first page is the bare address.
    await expect(pager.getByRole('link', { name: 'First page' })).toHaveAttribute('href', '/app/accounts');
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  });

  test('past the end: an honest message, not an empty queue', async ({ page }) => {
    await open(page, 'finance-queue-end');
    await expect(page.getByRole('heading', { name: 'No more deals after this point' })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('Nothing in the Accounts queue');
    await expect(page.getByRole('main')).not.toContainText('Nothing to check');
  });

  test('a complete queue shows no pager', async ({ page }) => {
    await open(page, 'finance-queue');
    await expect(page.getByRole('navigation', { name: 'Accounts queue pages' })).toHaveCount(0);
    await expect(page.getByRole('table')).toContainText('4 deals · All');
  });

  test('loading state announces itself and shows no figures', async ({ page }) => {
    await open(page, 'finance-loading');
    await expect(page.getByRole('status').filter({ hasText: 'Loading Accounts work…' })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('₹');
  });
});

const dealStates = ['deals-list-more', 'deals-list-later-page', 'deals-list-end'];

test.describe('Milestone A §4: deal list pages (numbered by Bitrix deal ID since the combined release)', () => {
  test('more deals: the caption counts every visible deal and a next-page link exists', async ({ page }) => {
    await open(page, 'deals-list-more');
    // Batch 1 true pager: the range counts every visible deal (caption and pager).
    await expect(page.getByRole('table', { name: '1–50 of 107 deals' })).toBeVisible();
    const next = page.getByRole('navigation', { name: 'Deal pages' }).getByRole('link', { name: 'Next page' });
    await expect(next).toHaveAttribute('href', '/app/deals?page=2');
  });

  test('a later page links back and has no next link at the end', async ({ page }) => {
    await open(page, 'deals-list-later-page');
    const pager = page.getByRole('navigation', { name: 'Deal pages' });
    await expect(pager.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/app/deals?page=2');
    await expect(pager.getByRole('link', { name: /^Next/ })).toHaveCount(0);
    await expect(pager).toContainText('101–107 of 107 deals');
  });

  test('no visible deals says so', async ({ page }) => {
    await open(page, 'deals-list-end');
    await expect(page.getByRole('heading', { name: 'No deals to show' })).toBeVisible();
  });

  for (const state of dealStates) {
    test(`axe clean on desktop and 390 px without sideways scroll: ${state}`, async ({ page }) => {
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
    });
  }
});
