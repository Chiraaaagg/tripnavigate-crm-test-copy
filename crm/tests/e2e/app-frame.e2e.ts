import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';

/**
 * Staff app frame (Direction A R0, 19 October 2026): grouped sidebar with the
 * account panel in its footer (desktop), a visible "Menu" button and slide-in
 * sheet under 1024px (no bottom bar), and the content-area loading and error
 * states, through the design preview states (synthetic props). Page content
 * inside the frame is covered by the existing screen tests.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FRAME_STATES = ['home-sales', 'deals-sales', 'deal-detail-sales', 'finance-queue', 'booking-health-off', 'app-frame-loading', 'app-frame-error', 'home-super-admin'];

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

/** The account panel's summary in the desktop sidebar footer. */
const accountSummary = (page: Page) => page.locator('#account-menu > summary');
const menuButton = (page: Page) => page.getByRole('button', { name: 'Menu', exact: true });

test.describe('staff app frame: accessibility', () => {
  for (const state of FRAME_STATES) {
    test(`axe clean at 1440, 375 and 200% zoom; no sideways scroll at 375 and 200% zoom: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await axe(page)).toEqual([]);

      await page.setViewportSize({ width: 375, height: 812 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);

      // 1280 px wide at 200% zoom: the layout a person sees is 640 CSS pixels wide.
      await page.setViewportSize({ width: 640, height: 900 });
      await open(page, state);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await noHorizontalScroll(page);
      await expect(menuButton(page)).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  }

  test('account panel and Menu sheet pass axe when open (desktop and phone)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'finance-queue');
    await accountSummary(page).click();
    await page.getByText('More sign-out options').click();
    expect(await axe(page)).toEqual([]);

    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, 'finance-queue');
    await menuButton(page).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('More sign-out options').click();
    expect(await axe(page)).toEqual([]);
  });

  test('reduced motion: the Menu sheet opens without animation and the loading pulse stops', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, 'app-frame-loading');
    const pulse = await page.locator('main [data-slot="skeleton"]').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(pulse).toBe('none');
    await menuButton(page).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    // The slide keyframes stay attached, but every motion duration token is zero under reduced motion.
    expect(await sheet.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('0s');
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('staff app frame: layout and behaviour', () => {
  test('desktop: grouped sidebar with the current page; name, role and branch in the account panel; no top bar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'finance-queue');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('group', { name: 'Work' }).getByRole('link')).toHaveText(['Home', 'Deals']);
    await expect(nav.getByRole('group', { name: 'Accounts' }).getByRole('link')).toHaveText([
      'To check',
      // Voice-note batch: stored customers that Accounts checks.
      'Customers to check',
      'Reported payments',
      'Department costs',
      'Branch cash',
      'Company accounts',
    ]);
    await expect(nav.getByRole('link', { name: 'To check', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    // My access left the menu (plan T5); it is in the account panel.
    await expect(nav.getByRole('link', { name: 'My access' })).toHaveCount(0);
    await expect(accountSummary(page)).toContainText('Synthetic Accounts Jodhpur');
    await expect(accountSummary(page)).toContainText('Accounts · Jodhpur');
    await expect(page.getByRole('banner')).toBeHidden();
    await expect(menuButton(page)).toBeHidden();
    // Both banners above the frame stay.
    await expect(page.getByRole('note').filter({ hasText: 'Local development environment' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'Design preview' })).toBeVisible();
  });

  test('Super Admin sees one Settings item (DA-250) whose tabs keep the six old addresses', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'home-super-admin');
    const settings = page.getByRole('navigation', { name: 'Main' }).getByRole('group', { name: 'Settings' });
    const links = settings.getByRole('link');
    await expect(links).toHaveText(['Settings']);
    await expect(links).toHaveAttribute('href', '/app/admin/staff');
    // The tabs inside Settings are links to today's addresses (L1), plus the new Company and branches page.
    await open(page, 'settings-features');
    const tabs = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link');
    expect(await tabs.evaluateAll((all) => all.map((a) => a.getAttribute('href')))).toEqual([
      '/app/admin/staff',
      '/app/admin/company',
      '/app/admin/finance-policy',
      '/app/admin/integration',
      // Voice-note batch: Imports (the preview owner holds the import right).
      '/app/admin/imports',
      '/app/admin/workflow',
      '/app/admin/bookings',
    ]);
  });

  test('skip link moves focus to the page content', async ({ page }) => {
    await open(page, 'deals-sales');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await expect(skip).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
  });

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 1440, height: 900 },
  ]) {
    test(`focused skip link is on top of the frame without banners (production-like) at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, 'deals-sales');
      // Production shows neither the environment nor the preview banner.
      await page.evaluate(() => document.querySelectorAll('body > [role="note"]').forEach((n) => n.remove()));
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'Skip to main content' });
      await expect(skip).toBeFocused();
      const onTop = await skip.evaluate((link) => {
        const box = link.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit === link || link.contains(hit);
      });
      expect(onTop, 'elementFromPoint at the focused skip link is the link').toBe(true);
    });
  }

  test('account panel: every role and branch, My access, Sign out; "Sign out everywhere" only behind a second step', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'home-manager');
    await accountSummary(page).click();
    const panel = page.locator('#account-menu');
    await expect(panel.getByRole('list', { name: 'Your roles' }).getByRole('listitem')).toHaveText(['Manager · Delhi', 'Sales · Jodhpur (head office)']);
    await expect(panel.getByRole('link', { name: 'My access' })).toHaveAttribute('href', '/app/access');
    await expect(panel.getByRole('button', { name: 'Sign out of this device' })).toBeVisible();
    // Second step: the "everywhere" button is not visible until the options are opened.
    const everywhere = panel.getByRole('button', { name: 'Sign out everywhere' });
    await expect(everywhere).toBeHidden();
    await panel.getByText('More sign-out options').click();
    await expect(everywhere).toBeVisible();
    await expect(everywhere).toHaveAccessibleDescription(
      'Signs you out on this and every other device. You will need your password and authenticator app to sign in again.',
    );
    // Both buttons post to the existing sign-out server actions (forms, no new behaviour).
    await expect(panel.locator('form')).toHaveCount(2);
  });

  test('My access is marked as the current page in the account panel on /app/access', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'my-access-manager');
    await accountSummary(page).click();
    await expect(page.locator('#account-menu').getByRole('link', { name: 'My access' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="page"]')).toHaveCount(0);
  });

  for (const { name, viewport, zoom } of [
    { name: 'small laptop 1024x600', viewport: { width: 1024, height: 600 }, zoom: false },
    { name: '1366x768 at 200% zoom (phone layout)', viewport: { width: 683, height: 384 }, zoom: true },
    { name: 'landscape phone 844x390', viewport: { width: 844, height: 390 }, zoom: false },
  ]) {
    test(`account panel: "Sign out everywhere" is reachable on a ${name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, 'finance-queue');
      if (zoom) {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
      }
      // Scroll the page, as when working in a long page.
      await page.evaluate(() => window.scrollTo(0, 400));
      let scope;
      if (viewport.width >= 1024) {
        await accountSummary(page).click();
        scope = page.locator('#account-menu');
      } else {
        await menuButton(page).click();
        scope = page.getByRole('dialog');
      }
      await scope.getByText('More sign-out options').click();
      const all = scope.getByRole('button', { name: 'Sign out everywhere' });
      await all.scrollIntoViewIfNeeded();
      await expect(all).toBeInViewport({ ratio: 1 });
      await all.focus();
      await expect(all).toBeFocused();
    });
  }

  test('account panel: opens by keyboard, Escape closes it and returns focus, outside click closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'home-sales');
    const summary = accountSummary(page);
    await summary.focus();
    await page.keyboard.press('Enter');
    const myAccess = page.locator('#account-menu').getByRole('link', { name: 'My access' });
    await expect(myAccess).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(myAccess).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Sign out of this device' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(myAccess).toBeHidden();
    await expect(summary).toBeFocused();
    await summary.click();
    await expect(myAccess).toBeVisible();
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await expect(myAccess).toBeHidden();
  });

  test('phone 375px: Menu sheet lists the same groups, every item is reachable, focus returns to Menu on close', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, 'home-super-admin');
    // No bottom bar and no sidebar on a phone: one visible "Menu" text button in the top bar.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(menuButton(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await menuButton(page).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // While the sheet is open the rest of the page is hidden from assistive technology, so read the attribute directly.
    await expect(page.locator('header button', { hasText: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    const nav = dialog.getByRole('navigation', { name: 'Main' });
    const expected = ['Home', 'Leads', 'Deals', 'Settings'];
    await expect(nav.getByRole('link')).toHaveText(expected);
    await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Home' })).toBeFocused();
    // Every item, then the account items, are reachable by Tab inside the sheet.
    for (const name of expected.slice(1)) {
      await page.keyboard.press('Tab');
      await expect(nav.getByRole('link', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('link', { name: 'My access' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Sign out of this device' })).toBeFocused();
    await expect(dialog.getByRole('region', { name: 'Your account' })).toContainText('Synthetic Owner Jodhpur');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
    // The close button also returns focus to Menu.
    await menuButton(page).click();
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
  });

  test('phone: following a link in the Menu sheet closes it', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, 'deal-detail-sales');
    await menuButton(page).click();
    const nav = page.getByRole('dialog').getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Home', 'Deals']);
    await expect(nav.getByRole('link', { name: 'Deals' })).toHaveAttribute('aria-current', 'page');
    // Stay on the gallery: stop the navigation, check the sheet closed.
    await page.route(/\/app\/deals/, (route) => route.abort());
    await nav.getByRole('link', { name: 'Deals' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('content-area loading state announces once and keeps the frame usable', async ({ page }) => {
    await open(page, 'app-frame-loading');
    await expect(page.locator('main').getByRole('status')).toHaveText('Loading…');
    await expect(page.locator('main [aria-busy="true"]')).toHaveCount(1);
    await expect(page.locator('main [role="status"][aria-busy]')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' })).toBeVisible();
  });

  test('page error: plain words (copy G-13), Try again and a way back to Home; the frame stays', async ({ page }) => {
    await open(page, 'app-frame-error');
    const alert = page.locator('main').getByRole('alert');
    await expect(alert.getByRole('heading', { level: 1 })).toHaveText('This page did not load');
    await expect(alert).toContainText('If you had just saved something, check it was saved before you try again. If it keeps happening, tell your admin.');
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(alert.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/app');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });
});

test.describe('staff app frame: old addresses keep working', () => {
  // Every address the menu offered before R0 (and My access) still exists: without a session the
  // gate sends the person to sign in and keeps the PATH to return to (never a 404). Known gap,
  // pre-existing and unchanged in Batch 1 (Echo M8, lead ruling): the sign-in gate (src/proxy.ts)
  // keeps only the path in `next`, so a query string such as ?entity= or ?filter= is dropped after
  // sign-in. No real-stack journey covers query strings. Recorded in the Batch 1 release record.
  const ADDRESSES = [
    '/app',
    '/app/access',
    '/app/leads',
    '/app/deals',
    // Batch 3 (FP-040, FP-051): new menu addresses and their New pages.
    '/app/quotations',
    '/app/quotations/new',
    '/app/itineraries',
    '/app/itineraries/new',
    '/app/purchase',
    '/app/purchase/suppliers',
    '/app/flight',
    '/app/visa',
    '/app/accounts',
    '/app/accounts/claims',
    '/app/accounts/expenses',
    '/app/accounts/cash',
    '/app/accounts/destinations',
    '/app/admin/staff',
    '/app/admin/access',
    '/app/admin/integration',
    '/app/admin/bookings',
    '/app/admin/workflow',
    '/app/admin/finance-policy',
  ];
  test('each former menu address still opens (sign-in gate, address kept)', async ({ page }) => {
    for (const path of ADDRESSES) {
      const response = await page.goto(`${path}?entity=synthetic&filter=all`);
      expect(response?.status(), path).toBe(200);
      await expect(page, path).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    }
  });
});

test.describe('staff app frame: production style policy', () => {
  test('frame states, account panel and Menu sheet: zero CSP violations', async ({ browser }) => {
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => url.pathname.startsWith('/preview/') && url.pathname !== '/preview/ui-gallery');
    const { violations } = await trackViolations(context);
    const page = await context.newPage();

    for (const state of FRAME_STATES) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html, `${state}: no server-rendered style attribute in the frame`).not.toMatch(/<(aside|header|nav|summary|details)\b[^>]*\sstyle="/i);
      await accountSummary(page).click();
      await page.locator('#account-menu').getByText('More sign-out options').click();
      await expect(page.getByRole('button', { name: 'Sign out everywhere' })).toBeVisible();
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, 'finance-queue');
    await menuButton(page).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.locator('head style[nonce]').count(), 'scroll-lock style tag carries a nonce').toBeGreaterThan(0);
    await page.keyboard.press('Escape');

    expect(applied.length).toBeGreaterThanOrEqual(FRAME_STATES.length + 1);
    expect(violations).toEqual([]);
    await context.close();
  });
});
