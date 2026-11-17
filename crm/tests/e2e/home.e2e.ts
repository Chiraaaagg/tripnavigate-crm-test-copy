import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';
import { brandEmphasis, primaryActions } from '../helpers/primary-actions';
import { reachableAddresses, sectionsFor, type SectionsViewer } from '../../src/app/app/sections';
import { settingsTabsFor } from '../../src/modules/settings/contracts';
// The pure row helpers (home-rows.ts): home-view.tsx imports next/link, which the Playwright loader cannot load.
import { homeRowButtonText, homeRowsFor, type HomeRow } from '../../src/views/home-rows';

/**
 * Home "What needs you" (Direction A HO-01, R0; UX redesign R2 SL-1, SL-19,
 * DM-18) through the design preview states (synthetic props). Home reads
 * nothing new: the role-scoped my_work_counts, shown only for the roles they
 * apply to (plan T4). Rows with something waiting have one button named for
 * the count; rows with nothing waiting have no button and sit folded below;
 * the top waiting row's button is the page's one primary action. Every link on
 * Home is one the menu already offers.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Batch 3: the Sales and Manager Home with the two quotation rows (FP-081).
/**
 * The Settings area addresses of each Home preview viewer, as settingsTabsFor gives them (src/modules/settings/contracts.ts;
 * each area's link and the addresses that mark it): the Super Admin preview viewer holds every right, including the
 * Bitrix connection page (no Purchase role), but not the import right. R1: Overview (/app/admin, the Settings item)
 * is the first area, and Customer messages is its own area.
 */
const SETTINGS_TABS_BY_STATE: Record<string, string[]> = {
  'home-super-admin': [
    '/app/admin',
    '/app/admin/staff',
    '/app/admin/access',
    '/app/admin/company',
    '/app/admin/finance-policy',
    '/app/admin/accounts',
    '/app/admin/integration',
    '/app/admin/workflow',
    '/app/admin/customer-messages',
    '/app/admin/bookings',
  ],
};
/**
 * The menu flags of each Home preview viewer (copied from the preview states: page.tsx, b1-states.tsx,
 * batch3-states.tsx). The test checks they give exactly the menu the preview renders.
 */
const NO_FLAGS: SectionsViewer = { canAdministerStaff: false, canManageGrants: false };
const HOME_VIEWER_BY_STATE: Record<string, SectionsViewer> = {
  'home-sales': NO_FLAGS,
  'home-nothing': NO_FLAGS,
  'home-my-work-unavailable': NO_FLAGS,
  'home-accounts': { ...NO_FLAGS, canUseAccounts: true, canCheckCustomers: true },
  'home-manager': { ...NO_FLAGS, canSeeLeads: true, canSeePurchaseTasks: true },
  'home-super-admin': { canAdministerStaff: true, canManageGrants: true, canManageIntegration: true, canOpenBitrixConnection: true, canSeeLeads: true, canManageFinancePolicy: true },
  'home-multi-role': { ...NO_FLAGS, canSeePurchaseTasks: true },
  'b3-home-sales': { ...NO_FLAGS, canSeeLeads: true, canSeeQuotations: true },
  'b3-home-manager': { ...NO_FLAGS, canSeeLeads: true, canSeeQuotations: true, canSeePurchaseTasks: true },
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
/** The folded "Nothing waiting in …" list (no buttons). */
const quiet = (page: Page) => needs(page).locator('[data-slot="fold"]');
const quietLabels = (page: Page) => quiet(page).locator('[data-slot="home-quiet-row"]');

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
  test('greeting, then straight to the work: one primary action, the top waiting row named for the count; no "Your deals" counts', async ({ page }) => {
    await open(page, 'home-manager');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Synthetic Manager Delhi');
    // The top waiting row's button is the page's one primary action (design plan 2.2).
    await expect(page.locator('main header').getByRole('link', { name: 'Open 5 drafts: Booking drafts you can continue' })).toHaveAttribute('href', '/app/deals');
    // Exactly one element in main carries the brand emphasis (fill or outline), and it is the one primary action.
    expect(await brandEmphasis(page.locator('main'))).toHaveLength(1);
    expect(await primaryActions(page.locator('main'))).toEqual(['Open 5 drafts']);
    // SL-19, DM-18: the Deal ownership counts repeated the Deals list and are gone; "What needs you" comes first.
    await expect(page.getByRole('region', { name: 'Your deals' })).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('Deals you can open');
    const first = await page.locator('main section').first().getAttribute('aria-labelledby');
    expect(first).toBe('needs-heading');
  });

  test('"What needs you": waiting rows with one button named for the count; nothing-waiting rows folded, no button; the Manager placeholder is hidden', async ({ page }) => {
    await open(page, 'home-manager');
    // DA-134 / Echo M3: no total of overlapping rows (5 drafts, 1 of them missing details, is not 6 things).
    await expect(page.locator('main header')).toContainText('Work is waiting for you below.');
    await expect(page.locator('main header')).not.toContainText(/\d+ things? needs?/);
    // Each count names its scope (owner handoff 19 October): a Manager's cover their branches too.
    await expect(rowLabels(page)).toHaveText([
      'Booking drafts you can continue',
      'Booking drafts missing details (your deals and branches)',
      'Confirmed deals needing a booking (your deals and branches)',
    ]);
    const buttons = needs(page).locator('tbody').getByRole('link');
    await expect(buttons).toHaveText(['Open 5 drafts', 'Complete 1 draft', 'Start 2 bookings']);
    await expect(needs(page).getByRole('link', { name: /^Start 2 bookings\W+Confirmed deals needing a booking \(your deals and branches\)$/ })).toHaveAttribute('href', '/app/deals');
    // SL-19: a row with nothing waiting has no button; it sits in the fold, closed until opened.
    await expect(needs(page).locator('table')).not.toContainText('Nothing waiting');
    await expect(quiet(page).locator('summary')).toHaveText('Nothing waiting in 1 other list');
    await expect(quiet(page)).not.toHaveAttribute('open', '');
    await quiet(page).locator('summary').click();
    await expect(quietLabels(page)).toHaveText(['Returned by Accounts (your deals and branches)']);
    await expect(quiet(page).getByRole('link')).toHaveCount(0);
    await expect(needs(page)).not.toContainText('Requests to approve');
  });

  for (const state of HOME_STATES) {
    // Lead ruling (Batch 3): a row may open a menu address with a query (/app/quotations?filter=…); the address itself must be
    // reachable from the menu. UX redesign R1: an Accounts list is a tab of one of the six section links, so "reachable" is
    // reachableAddresses() of the state's viewer (sections.ts), checked against the menu the page really shows.
    test(`every link on Home opens an address the menu or the Deals list offers: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      const viewer = HOME_VIEWER_BY_STATE[state]!;
      expect(viewer, `${state}: viewer flags listed`).toBeDefined();
      // The hand-copied flags must give exactly the menu this preview renders (so they cannot drift from the preview).
      const shown = await page
        .getByRole('navigation', { name: 'Main' })
        .locator('a[data-section]')
        .evaluateAll((links) => links.map((a) => a.getAttribute('data-section')));
      expect(shown, `${state}: menu sections`).toEqual(sectionsFor(viewer).map((s) => s.key));
      const reachable = reachableAddresses(viewer);
      const homeHrefs = await page
        .locator('main')
        .getByRole('link')
        .evaluateAll((links) => links.map((a) => (a.getAttribute('href') ?? '').split('?')[0]));
      expect(homeHrefs.length).toBeGreaterThan(0);
      // Batch 4 (DA-250, L1; Echo-B L6): a Settings address counts only when it is one of THIS viewer's Settings
      // tabs (settingsTabsFor of the state's viewer flags) and the menu has the Settings item.
      const tabs = SETTINGS_TABS_BY_STATE[state] ?? [];
      // The hand-written list must be exactly this viewer's Settings areas (so it cannot drift from settingsTabsFor).
      const areas = settingsTabsFor({ ...viewer, canManageIntegration: !!viewer.canManageIntegration, canOpenBitrixConnection: !!viewer.canOpenBitrixConnection, canManageFinancePolicy: !!viewer.canManageFinancePolicy });
      expect([...tabs].sort(), `${state}: Settings areas`).toEqual([...new Set(areas.flatMap((t) => [t.href, ...t.matchPrefixes]))].sort());
      const hasSettings = reachable.some((h) => tabs.includes(h));
      for (const href of homeHrefs) {
        if (hasSettings && href && tabs.includes(href)) continue;
        expect(reachable, `${state}: ${href}`).toContain(href);
      }
    });
  }

  test('each role sees only the counts that apply to it (no Sales-only zeros)', async ({ page }) => {
    await open(page, 'home-sales');
    await expect(rowLabels(page)).toHaveText(['Booking drafts you can continue', 'Returned by Accounts (your deals)', 'Booking drafts missing details (your deals)']);
    await expect(quietLabels(page)).toHaveText(['Confirmed deals needing a booking (your deals)']);
    await open(page, 'home-accounts');
    await expect(rowLabels(page)).toHaveText([
      'Bookings to review in your companies',
      'Receipts to verify (recorded by someone else)',
      'Reported payments to check in your companies',
    ]);
    await expect(quietLabels(page)).toHaveText(['Department costs to review (submitted by someone else)']);
    await expect(needs(page).getByRole('link', { name: /^Verify 2 receipts\W+Receipts to verify/ })).toHaveAttribute('href', '/app/accounts?filter=awaiting_verification');
    await expect(page.locator('main header').getByRole('link', { name: /^Review 4 bookings\W+Bookings to review/ })).toHaveAttribute('href', '/app/accounts?filter=needs_review');
    await open(page, 'home-multi-role');
    // Batch 1: drafts read draftsToContinue on their own row; the other role's queue is a separate row
    // (waitingForMe minus the drafts), so a Sales + Purchase person sees both, never one merged total.
    await expect(rowLabels(page).nth(0)).toHaveText('Booking drafts you can continue');
    await expect(needs(page).locator('tbody tr td:nth-child(2)').nth(0)).toHaveText('3');
    const purchaseRow = needs(page).locator('tbody tr', { hasText: 'Purchase tasks not taken yet, or yours in progress' });
    await expect(purchaseRow).toContainText('4');
    await expect(purchaseRow.getByRole('link')).toHaveText('Open 4 tasks');
    await expect(purchaseRow.getByRole('link')).toHaveAttribute('href', '/app/purchase');
    // Accounts phase 3 (contract 15 Nav): Purchase also has "Rate contracts".
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Home', 'Deals', 'Purchase tasks', 'Suppliers', 'Rate contracts']);
  });

  test('the Visa desk is one click from Home', async ({ page }) => {
    await open(page, 'b11-home-visa');
    // The waiting Visa row is the page's one primary action, named for the count.
    await expect(page.locator('main header').getByRole('link', { name: /^Open 2 tasks\W+Visa and passport tasks/ })).toHaveAttribute('href', '/app/visa');
  });

  test('Super Admin with no work role: the one primary opens Settings work, not an empty Deals list (Echo L10)', async ({ page }) => {
    await open(page, 'home-super-admin');
    await expect(page.locator('main header').getByRole('link', { name: 'Open Bitrix connection' })).toHaveAttribute('href', '/app/admin/integration');
    await expect(page.locator('main').getByRole('link', { name: 'Go to deals' })).toHaveCount(0);
  });

  test('empty: one message, "Nothing needs you right now"; never two empty cards; nothing-waiting lists folded below', async ({ page }) => {
    await open(page, 'home-super-admin');
    await expect(needs(page).getByRole('heading', { name: 'Nothing needs you right now' })).toBeVisible();
    await expect(needs(page).locator('table')).toHaveCount(0);
    await expect(page.locator('main [data-slot="empty-state"]')).toHaveCount(1);
    await expect(quiet(page)).toHaveCount(0);
    // No waiting row: the primary is the person's own work area.
    expect(await primaryActions(page.locator('main'))).toEqual(['Open Bitrix connection']);
    await open(page, 'home-nothing');
    await expect(page.locator('main header')).toContainText('Nothing needs you right now.');
    await expect(needs(page).locator('table')).toHaveCount(0);
    await expect(page.locator('main [data-slot="empty-state"]')).toHaveCount(1);
    await expect(quiet(page).locator('summary')).toHaveText('Nothing waiting in 4 lists');
    await quiet(page).locator('summary').click();
    await expect(quietLabels(page)).toHaveCount(4);
    await expect(quiet(page).getByRole('link')).toHaveCount(0);
    expect(await primaryActions(page.locator('main'))).toEqual(['Go to deals']);
    await expect(page.locator('main header').getByRole('link', { name: 'Go to deals' })).toHaveAttribute('href', '/app/deals');
  });

  test('error: counts unavailable is said in words, never shown as zero', async ({ page }) => {
    await open(page, 'home-my-work-unavailable');
    await expect(needs(page).getByRole('status')).toHaveText('Counts unavailable. Reload; nothing is affected.');
    await expect(page.locator('main')).not.toContainText('Nothing needs you');
    await expect(page.locator('main')).not.toContainText('Nothing waiting');
    // No count was read, so no row can be the primary: the person's main queue is.
    expect(await primaryActions(page.locator('main'))).toEqual(['Go to deals']);
  });

  test('"Not available yet" is on demand (closed until opened)', async ({ page }) => {
    await open(page, 'home-sales');
    await expect(page.getByRole('region', { name: 'Not available yet' })).toHaveCount(0);
    await page.getByText('What this CRM does not do yet').click();
    await expect(page.getByRole('region', { name: 'Not available yet' })).toContainText('Sales leads, follow-ups and stages stay in Bitrix.');
  });

  test('Home links show the design-system focus outline (brand blue)', async ({ page }) => {
    await open(page, 'home-accounts');
    const link = needs(page).locator('tbody').getByRole('link').first();
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

test.describe('Home: row buttons and the menu gate (pure functions, no page)', () => {
  const row = (over: Partial<HomeRow>): HomeRow => ({ key: 'draftsToContinue', label: 'x', count: 1, href: '/app/deals', action: 'Open deals', icon: (() => null) as unknown as HomeRow['icon'], ...over });

  test('buttons are named for the count, singular and plural; one-record rows keep their words', () => {
    expect(homeRowButtonText(row({ count: 1 }))).toBe('Open 1 draft');
    expect(homeRowButtonText(row({ count: 1250 }))).toBe('Open 1,250 drafts');
    expect(homeRowButtonText(row({ key: 'returnedToMe', count: 2 }))).toBe('Fix 2 bookings');
    expect(homeRowButtonText(row({ key: 'receiptsToVerify', count: 3 }))).toBe('Verify 3 receipts');
    expect(homeRowButtonText(row({ key: 'flightPaymentsMissing', count: 2 }))).toBe('Pay 2 batches');
    // The combined row counts the queue it opens; across several roles it says "waiting".
    expect(homeRowButtonText(row({ key: 'waitingForMe', count: 4, href: '/app/accounts?filter=needs_review' }))).toBe('Review 4 bookings');
    expect(homeRowButtonText(row({ key: 'waitingForMe', count: 7, label: 'Waiting for you across your roles' }))).toBe('Open 7 waiting');
    // A row that opens one record keeps its words: the count may cover more than that record.
    expect(homeRowButtonText(row({ key: 'salesFlightChangesToDecide', count: 2, href: '/app/deals/d1?tab=services', action: 'Open the deal' }))).toBe('Open the deal');
    expect(homeRowButtonText(row({ key: 'purchaseBookingChanged', count: 3, href: '/app/purchase/t1', action: 'Open the oldest' }))).toBe('Open the oldest');
  });

  test('with the menu flags, Home keeps only rows whose address the menu offers (sections.ts mayOpenAddress)', () => {
    const rows = [
      row({ key: 'draftsToContinue', href: '/app/deals' }),
      row({ key: 'purchaseTasksNotTaken', href: '/app/purchase' }),
      row({ key: 'receiptsToVerify', href: '/app/accounts?filter=awaiting_verification' }),
      row({ key: 'salesVisaResultsToSee', href: '/app/deals/d1?tab=services#visa-results' }),
    ];
    const sales: SectionsViewer = { canAdministerStaff: false, canManageGrants: false };
    expect(homeRowsFor(rows, sales).map((r) => r.key)).toEqual(['draftsToContinue', 'salesVisaResultsToSee']);
    const purchase: SectionsViewer = { ...sales, canSeePurchaseTasks: true, canSeePurchasePayments: true };
    expect(homeRowsFor(rows, purchase).map((r) => r.key)).toEqual(['draftsToContinue', 'purchaseTasksNotTaken', 'salesVisaResultsToSee']);
    // Without the flags (older callers, the gallery) nothing is filtered.
    expect(homeRowsFor(rows)).toHaveLength(4);
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
