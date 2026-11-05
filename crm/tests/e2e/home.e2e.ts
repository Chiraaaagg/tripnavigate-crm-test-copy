import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';

/**
 * Home "What needs you" (Direction A HO-01, R0) through the design preview
 * states (synthetic props). Home reads nothing new: the deal counts it has
 * always shown and the role-scoped my_work_counts, shown only for the roles
 * they apply to (plan T4), each with one button to an address that works
 * today. Every link on Home is one the menu (or the Deals list) already offers.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Batch 3: the Sales and Manager Home with the two quotation rows (FP-081).
/**
 * The Settings tabs of each Home preview viewer, as settingsTabsFor gives them (src/modules/settings/contracts.ts):
 * the Super Admin preview viewer holds every right, including the Bitrix connection page (no Purchase role).
 */
const SETTINGS_TABS_BY_STATE: Record<string, string[]> = {
  'home-super-admin': ['/app/admin/staff', '/app/admin/access', '/app/admin/company', '/app/admin/finance-policy', '/app/admin/integration', '/app/admin/workflow', '/app/admin/bookings'],
};
const HOME_STATES = ['home-sales', 'home-accounts', 'home-manager', 'home-nothing', 'home-super-admin', 'home-multi-role', 'home-my-work-unavailable', 'b3-home-sales', 'b3-home-manager'];

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

const needs = (page: Page) => page.getByRole('region', { name: 'What needs you', exact: true });
const rowLabels = (page: Page) => needs(page).locator('tbody tr td:first-child');

test.describe('Home: accessibility', () => {
  for (const state of HOME_STATES) {
    test(`axe clean at 1440, 375 and 200% zoom; one h1; no sideways scroll: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);

      await page.setViewportSize({ width: 375, height: 812 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);

      await page.setViewportSize({ width: 640, height: 900 });
      await open(page, state);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('Home: content and permissions', () => {
  test('greeting, one primary action and the three deal counts as links to the Deals list', async ({ page }) => {
    await open(page, 'home-manager');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Synthetic Manager Delhi');
    await expect(page.locator('main').getByRole('link', { name: 'Go to deals' })).toHaveAttribute('href', '/app/deals');
    await expect(page.locator('main .border-brand-strong, main [class*="bg-brand-strong"]')).toHaveCount(1);
    const deals = page.getByRole('region', { name: 'Your deals' });
    // DA-135 / Echo M4: each chip opens the Deals list with the same filter and the list's own scope words.
    await expect(deals.getByRole('link')).toHaveText([/^Deals you can open\s*1,284$/, /^Owned by you\s*12$/, /^Assigned to you, owned by someone else\s*3$/]);
    expect(await deals.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href')))).toEqual([
      '/app/deals',
      '/app/deals?filter=owned',
      '/app/deals?filter=assigned',
    ]);
  });

  test('"What needs you": rows with a count, words for zero, one button each; the Manager placeholder is hidden', async ({ page }) => {
    await open(page, 'home-manager');
    // DA-134 / Echo M3: no total of overlapping rows (5 drafts, 1 of them missing details, is not 6 things).
    await expect(page.locator('main header')).toContainText('Work is waiting for you below.');
    await expect(page.locator('main header')).not.toContainText(/\d+ things? needs?/);
    // Each count names its scope (owner handoff 19 October): a Manager's cover their branches too.
    await expect(rowLabels(page)).toHaveText([
      'Booking drafts you can continue',
      'Returned by Accounts (your deals and branches)',
      'Booking drafts missing details (your deals and branches)',
      'Confirmed deals needing a booking (your deals and branches)',
    ]);
    await expect(needs(page).locator('tbody tr').nth(1)).toContainText('Nothing waiting');
    await expect(needs(page)).not.toContainText('Requests to approve');
    await expect(needs(page).getByRole('link', { name: /^Open deals\W+Returned by Accounts \(your deals and branches\)$/ })).toHaveAttribute('href', '/app/deals');
  });

  for (const state of HOME_STATES) {
    // Lead ruling (Batch 3): a row may open a menu address with a query (/app/quotations?filter=…); the address itself must be in the menu.
    test(`every link on Home opens an address the menu or the Deals list offers: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      const navHrefs = await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link')
        .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
      const homeHrefs = await page
        .locator('main')
        .getByRole('link')
        .evaluateAll((links) => links.map((a) => (a.getAttribute('href') ?? '').split('?')[0]));
      expect(homeHrefs.length).toBeGreaterThan(0);
      // Batch 4 (DA-250, L1; Echo-B L6): a Settings address counts only when it is one of THIS viewer's Settings
      // tabs (settingsTabsFor of the state's viewer flags) and the menu has the Settings item.
      const tabs = SETTINGS_TABS_BY_STATE[state] ?? [];
      const hasSettings = navHrefs.some((h) => h !== null && tabs.includes(h));
      for (const href of homeHrefs) {
        if (hasSettings && href && tabs.includes(href)) continue;
        expect(navHrefs, `${state}: ${href}`).toContain(href);
      }
    });
  }

  test('each role sees only the counts that apply to it (no Sales-only zeros)', async ({ page }) => {
    await open(page, 'home-sales');
    await expect(rowLabels(page)).toHaveText([
      'Booking drafts you can continue',
      'Returned by Accounts (your deals)',
      'Booking drafts missing details (your deals)',
      'Confirmed deals needing a booking (your deals)',
    ]);
    await open(page, 'home-accounts');
    await expect(rowLabels(page)).toHaveText([
      'Bookings to review in your companies',
      'Receipts to verify (recorded by someone else)',
      'Reported payments to check in your companies',
      'Department costs to review (submitted by someone else)',
    ]);
    await expect(needs(page).getByRole('link', { name: /^Open To check\W+Receipts to verify/ })).toHaveAttribute('href', '/app/accounts?filter=awaiting_verification');
    await expect(page.locator('main').getByRole('link', { name: 'Open To check', exact: true })).toHaveAttribute('href', '/app/accounts');
    await open(page, 'home-multi-role');
    // Batch 1: drafts read draftsToContinue on their own row; the other role's queue is a separate row
    // (waitingForMe minus the drafts), so a Sales + Purchase person sees both, never one merged total.
    await expect(rowLabels(page).nth(0)).toHaveText('Booking drafts you can continue');
    await expect(needs(page).locator('tbody tr td:nth-child(2)').nth(0)).toHaveText('3');
    await expect(needs(page).locator('tbody tr', { hasText: 'Purchase tasks not taken yet, or yours in progress' })).toContainText('4');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Home', 'Deals', 'Purchase tasks', 'Suppliers']);
  });

  test('the Visa desk is one click from Home', async ({ page }) => {
    await open(page, 'b11-home-visa');
    await expect(page.locator('main').getByRole('link', { name: 'Open Visa and passport tasks', exact: true })).toHaveAttribute('href', '/app/visa');
  });

  test('Super Admin with no work role: the one primary opens Settings work, not an empty Deals list (Echo L10)', async ({ page }) => {
    await open(page, 'home-super-admin');
    await expect(page.locator('main header').getByRole('link', { name: 'Open Bitrix connection' })).toHaveAttribute('href', '/app/admin/integration');
    await expect(page.locator('main').getByRole('link', { name: 'Go to deals' })).toHaveCount(0);
  });

  test('empty: one message, "Nothing needs you right now"; never two empty cards', async ({ page }) => {
    await open(page, 'home-super-admin');
    await expect(needs(page).getByRole('heading', { name: 'Nothing needs you right now' })).toBeVisible();
    await expect(needs(page).locator('table')).toHaveCount(0);
    await expect(page.locator('main [data-slot="empty-state"]')).toHaveCount(1);
    await open(page, 'home-nothing');
    await expect(page.locator('main header')).toContainText('Nothing needs you right now.');
    await expect(needs(page).locator('tbody tr')).toHaveCount(4);
    await expect(needs(page).locator('tbody tr')).toContainText(['Nothing waiting', 'Nothing waiting', 'Nothing waiting', 'Nothing waiting']);
  });

  test('error: counts unavailable is said in words, never shown as zero', async ({ page }) => {
    await open(page, 'home-my-work-unavailable');
    await expect(needs(page).getByRole('status')).toHaveText('Counts unavailable. Reload; nothing is affected.');
    await expect(page.locator('main')).not.toContainText('Nothing needs you');
    await expect(page.locator('main')).not.toContainText('Nothing waiting');
  });

  test('"Not available yet" is on demand (closed until opened)', async ({ page }) => {
    await open(page, 'home-sales');
    await expect(page.getByRole('region', { name: 'Not available yet' })).toHaveCount(0);
    await page.getByText('What this CRM does not do yet').click();
    await expect(page.getByRole('region', { name: 'Not available yet' })).toContainText('Sales leads, follow-ups and stages stay in Bitrix.');
  });

  test('Home links show the design-system focus outline (brand blue)', async ({ page }) => {
    await open(page, 'home-accounts');
    const link = page.getByRole('region', { name: 'Your deals' }).getByRole('link').first();
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    const outline = await link.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor };
    });
    expect(outline).toEqual({ style: 'solid', width: 2, color: 'rgb(0, 74, 173)' });
  });
});

test.describe('Home: production style policy', () => {
  test('every Home state renders with zero CSP violations', async ({ browser }) => {
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => HOME_STATES.some((s) => url.pathname === `/preview/${s}`));
    const { violations } = await trackViolations(context);
    const page = await context.newPage();
    for (const state of HOME_STATES) {
      await open(page, state);
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html, `${state}: no server-rendered style attribute in main`).not.toMatch(/<main[\s\S]*<[a-z][^>]*\sstyle="[\s\S]*<\/main>/i);
    }
    expect(applied.length).toBe(HOME_STATES.length);
    expect(violations).toEqual([]);
    await context.close();
  });
});
