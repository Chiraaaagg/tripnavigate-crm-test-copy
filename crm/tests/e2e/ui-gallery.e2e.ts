import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';

/**
 * Shared design system gallery (/preview/ui-gallery): accessibility, visible
 * keyboard focus, and the PRODUCTION style policy.
 *
 * The gallery exists only on the local dev server (it 404s in production
 * builds; csp.prod.e2e.ts asserts that). `next dev` relaxes style-src to
 * 'unsafe-inline', which would hide exactly the failures that matter for a
 * component library (server-rendered style attributes, un-nonced <style>
 * tags). So every gallery document here is served with its style-src replaced
 * by the production directive built by src/lib/csp.ts for the same nonce:
 * style-src 'self' 'nonce-…' (no 'unsafe-inline'). script-src stays the dev
 * one only because the dev runtime needs 'unsafe-eval'; the production
 * script-src is proven by csp.prod.e2e.ts.
 */

const GALLERY = '/preview/ui-gallery';

test.use(LOCAL_NETWORK_ACCESS_OFF);
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function openGallery(page: Page) {
  const response = await page.goto(GALLERY, { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Good morning, Asha' })).toBeVisible();
}

test.describe('design system gallery', () => {
  test('renders every component with zero CSP violations under the production style policy', async ({ browser }) => {
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => url.pathname === GALLERY);
    const { violations, devOverlay } = await trackViolations(context);
    const page = await context.newPage();
    await openGallery(page);
    expect(applied.length, 'the production style policy was applied').toBeGreaterThan(0);

    // No server-rendered style attribute anywhere (the policy cannot nonce attributes).
    const html = await (await page.request.get(GALLERY)).text();
    expect(html).not.toMatch(/<[a-z][^>]*\sstyle="/i);

    // Every overlay opens and closes under the policy. Dialog and drawer use the
    // scroll lock's <style> tag, which must carry the nonce (NonceBridge).
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Send quote to Sample Customer A?' })).toBeVisible();
    expect(await page.locator('head style[nonce]').count(), 'scroll-lock style tag carries a nonce').toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open dialog' })).toBeFocused();

    await page.getByRole('button', { name: 'Open side panel' }).click();
    await expect(page.getByRole('dialog', { name: 'SAMPLE — Goa family trip' })).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Edit travel dates' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    await page.getByRole('button', { name: 'New Deal' }).nth(1).focus();
    await expect(page.getByRole('tooltip')).toContainText('Creates a Deal for a Lead you already own');

    await page.getByRole('button', { name: 'Show error' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Not saved.' })).toBeVisible();
    await page.getByRole('button', { name: 'Show success' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Quote sent to Sample Customer A.' })).toBeVisible();

    // router.refresh() re-renders the root layout for a new request (new nonce).
    // The scroll-lock style must still carry THIS document's nonce.
    const refreshed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === GALLERY && r.request().headers()['rsc'] === '1' && r.ok(),
    );
    await page.getByRole('button', { name: 'Refresh page data' }).click();
    await refreshed;
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Send quote to Sample Customer A?' })).toBeVisible();
    const documentNonce = applied[0]!.match(/style-src 'self' 'nonce-([^']+)'/)![1];
    const styleNonces = await page.locator('head style[nonce]').evaluateAll((els) => els.map((el) => (el as HTMLStyleElement).nonce));
    expect(styleNonces.length, 'scroll-lock style tag after refresh').toBeGreaterThan(0);
    for (const n of styleNonces) expect(n).toBe(documentNonce);
    await page.keyboard.press('Escape');

    expect(violations).toEqual([]);
    test.info().annotations.push({ type: 'dev-overlay-violations-excluded', description: String(devOverlay.length) });
    await context.close();
  });

  test('passes axe (WCAG 2.2 AA) closed, with a dialog open, and at phone width', async ({ page }) => {
    await openGallery(page);
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Wait for the entry animation so colour contrast is measured on the final frame.
    await page.waitForTimeout(400);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle' });
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(400);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test('keyboard focus is always visible (2px brand outline) on interactive components', async ({ page }) => {
    await openGallery(page);
    const checked = new Set<string>();
    let previous = '';
    // Tab through the page; every focused element must show the design system's
    // focus: a solid outline of at least 2px in brand-strong, brand blue (danger on an
    // invalid field). The legacy yellow outline would mean a component forgot
    // its focus style.
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          key: `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}#${el.id}`,
          inUi: Boolean(el.closest('main, aside, header')),
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        };
      });
      if (!info || !info.inUi) continue;
      // A date input keeps focus over several Tab presses (day, month, year
      // segments and Chrome's picker button inside its own shadow tree); it is
      // checked when focus first arrives.
      if (info.key === previous) continue;
      previous = info.key;
      checked.add(info.key);
      const ring =
        info.outlineStyle === 'solid' &&
        info.outlineWidth >= 2 &&
        ['rgb(0, 74, 173)', 'rgb(185, 28, 28)'].includes(info.outlineColor);
      expect(ring, `visible focus on ${info.key}: ${JSON.stringify(info)}`).toBe(true);
    }
    expect(checked.size).toBeGreaterThan(30);

    // The mobile menu drawer traps and returns focus.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle' });
    const trigger = page.getByRole('button', { name: 'Menu', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('link', { name: 'Home' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test('has no horizontal page scroll at 390px and stacks the table into labelled rows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGallery(page);
    const [scrollWidth, clientWidth] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    // Stacked: the header row is visually hidden (sr-only), not removed, so the
    // column headers stay in the accessibility tree.
    const stage = page.getByRole('columnheader', { name: 'Stage' });
    await expect(stage).toHaveCount(1);
    const thead = await stage.evaluate((th) => {
      const head = th.closest('thead')!;
      const s = getComputedStyle(head);
      const box = head.getBoundingClientRect();
      const clipped = s.clip === 'rect(0px, 0px, 0px, 0px)' || (s.clipPath !== 'none' && s.clipPath !== '');
      return { position: s.position, clipped, small: box.width <= 1 && box.height <= 1 };
    });
    expect(thead).toEqual({ position: 'absolute', clipped: true, small: true });
    const firstLabel = await page
      .getByRole('region', { name: 'Sample Deals' })
      .locator('td[data-label="Stage"]')
      .first()
      .evaluate((td) => getComputedStyle(td, '::before').content);
    expect(firstLabel).toBe('"Stage"');
  });
});

/**
 * UX redesign R0 shared parts (/preview/ui-gallery/redesign): every new part
 * in every state, under the production style policy (build plan 4.1, 4.2).
 * Also the 4.2 checks of Radix Alert Dialog (focus trap, Escape, focus return,
 * Cancel first) and Radix Collapsible (one group open and one closed on first
 * load, no refused style, no style attribute in the server HTML).
 */
const REDESIGN = '/preview/ui-gallery/redesign';

async function openRedesign(page: Page, query = '') {
  const response = await page.goto(`${REDESIGN}${query}`, { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Redesign shared parts' })).toBeVisible();
}

test.describe('redesign parts gallery', () => {
  test('renders every part with zero CSP violations under the production style policy', async ({ browser }) => {
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => url.pathname === REDESIGN);
    const { violations, devOverlay } = await trackViolations(context);
    const page = await context.newPage();
    await openRedesign(page);
    expect(applied.length, 'the production style policy was applied').toBeGreaterThan(0);

    // No server-rendered style attribute (Radix Collapsible content included) and no inline script without a nonce.
    const html = await (await page.request.get(REDESIGN)).text();
    expect(html).not.toMatch(/<[a-z][^>]*\sstyle="/i);
    expect(html).not.toMatch(/<script(?![^>]*\bnonce=)(?![^>]*\bsrc=)[^>]*>/i);

    // Collapsible: Sales open, Desks closed on first load; both toggle under the policy.
    const sales = page.getByRole('button', { name: 'Sales', exact: true });
    const desks = page.getByRole('button', { name: /^Desks/ });
    await expect(sales).toHaveAttribute('aria-expanded', 'true');
    await expect(desks).toHaveAttribute('aria-expanded', 'false');
    const groups = page.getByRole('navigation', { name: 'Sample menu groups' });
    await expect(groups.getByText('Purchase tasks', { exact: true })).toBeHidden();
    await desks.click();
    await expect(desks).toHaveAttribute('aria-expanded', 'true');
    await expect(groups.getByText('Purchase tasks', { exact: true })).toBeVisible();
    await sales.click();
    await expect(sales).toHaveAttribute('aria-expanded', 'false');
    await expect(groups.getByText('Quotations', { exact: true })).toBeHidden();

    // Alert Dialog: role alertdialog, Cancel focused first, Escape closes, focus returns to the opener.
    const opener = page.getByRole('button', { name: 'Open confirm (optional reason)' });
    await opener.click();
    const dialog = page.getByRole('alertdialog', { name: 'Switch Staff notices on?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await page.locator('head style[nonce]').count(), 'scroll-lock style tag carries a nonce').toBeGreaterThan(0);
    // Focus stays inside (trap): Tab cycles through the dialog's own controls.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Optional reason: may be left empty; the save closes the dialog and says so beside the opener,
    // in a status region that was already in the page (empty), so it is announced.
    const region = page.locator('[data-slot="confirm-change"]').filter({ has: opener }).getByRole('status');
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText('');
    await opener.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Switch on' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(region).toHaveText(/staff_notices changed with no reason given/);

    expect(violations).toEqual([]);
    test.info().annotations.push({ type: 'dev-overlay-violations-excluded', description: String(devOverlay.length) });
    await context.close();
  });

  test('required reason: refused below 10 characters and by the server, the typed reason stays', async ({ page }) => {
    await openRedesign(page);
    await page.getByRole('button', { name: 'Open confirm (required reason)' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Return payment request SAMPLE-P-102?' });
    const reason = dialog.getByRole('textbox', { name: 'Reason' });
    await reason.fill('too short');
    await dialog.getByRole('button', { name: 'Return' }).click();
    await expect(dialog.getByText('Write the reason: at least 10 characters. Nothing was changed.')).toBeVisible();
    await expect(reason).toBeFocused();
    await expect(reason).toHaveAttribute('aria-invalid', 'true');
    await expect(reason).toHaveValue('too short');

    await reason.fill('Please refuse this sample return');
    await dialog.getByRole('button', { name: 'Return' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Sample refusal' })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(reason).toHaveValue('Please refuse this sample return');
    await expect(reason).toBeFocused();

    await reason.fill('The supplier invoice number is missing.');
    await dialog.getByRole('button', { name: 'Return' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Returned (gallery only)' }).first()).toBeVisible();
  });

  test('approval rows, switch rows, jumps and the queue toolbar work by keyboard and address', async ({ page }) => {
    await openRedesign(page);
    // Every row button names its record; the blocked row says why.
    await expect(page.getByRole('button', { name: 'Approve SAMPLE-P-102' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Return SAMPLE-P-102' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Approve SAMPLE-P-103' })).toBeDisabled();
    await expect(page.getByText('You raised this, so a different person approves it.')).toBeVisible();

    // Switch rows: state in words, change button described by the switch name and state.
    const change = page.locator('#g-sw-goahead-row').getByRole('button', { name: 'Change' });
    await expect(change).toHaveAccessibleDescription(/Hotel go-ahead.*State: On/);
    await expect(page.locator('#g-sw-unknown-row')).toContainText('Not known');
    await expect(page.locator('#g-sw-blocked-row').getByRole('button', { name: 'Change' })).toBeDisabled();

    // Jump: opens the closed fold around the target and focuses it.
    await expect(page.locator('#g-r-fold-rates')).not.toHaveAttribute('open', '');
    await page.getByRole('link', { name: 'Go to services' }).click();
    await expect(page.locator('#g-r-folded-target')).toBeFocused();
    await expect(page.locator('#g-r-fold-rates')).toHaveAttribute('open', '');

    // Tabs stay links with aria-current; "count not known" is spoken, never 0.
    const queueTabs = page.getByRole('navigation', { name: 'Sample queue views' });
    await expect(queueTabs.getByRole('link', { name: /^Mine\s*,\s*3$/ })).toHaveAttribute('aria-current', 'page');
    await expect(queueTabs.getByRole('link', { name: /^All\s*,\s*count not known$/ })).toBeVisible();
    const moneyOut = page.getByRole('navigation', { name: 'Money out sections' });
    await expect(moneyOut.getByRole('link')).toHaveCount(5);
    await expect(moneyOut.getByRole('link', { name: /^Supplier payments/ })).toHaveAttribute('aria-current', 'page');
    const moneyIn = page.getByRole('navigation', { name: 'Money in sections' });
    await expect(moneyIn.getByRole('link')).toHaveCount(3);
    await expect(moneyIn.getByRole('link', { name: /^Small balances/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Tally sections' })).toHaveCount(0);

    // Queue toolbar: first four chips, the rest under More; search keeps the chip's filter; sort submits on change.
    const filters = page.getByRole('navigation', { name: 'Sample task filters' });
    await expect(filters.getByRole('link')).toHaveCount(4);
    await expect(filters.getByRole('link', { name: /^Returned.*count not known/ })).toBeVisible();
    await page.locator('[data-slot="more-chips"] > summary').click();
    await expect(page.getByRole('link', { name: /^Done/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: /^Done/ })).toBeHidden();
    await filters.getByRole('link', { name: /^Not taken/ }).click();
    await page.waitForURL(/filter=not-taken/);
    const search = page.getByRole('searchbox', { name: 'Search sample tasks' });
    await search.fill('Udaipur');
    await search.press('Enter');
    await page.waitForURL(/q=Udaipur/);
    expect(new URL(page.url()).searchParams.get('filter')).toBe('not-taken');
    await expect(page.getByText('Showing matches for “Udaipur”.')).toBeVisible();
    await page.getByLabel('Sort by').selectOption('travel');
    await page.waitForURL(/sort=travel/);
    const url = new URL(page.url());
    expect([url.searchParams.get('filter'), url.searchParams.get('q'), url.searchParams.get('sort')]).toEqual(['not-taken', 'Udaipur', 'travel']);
    await expect(page.getByText('Shown for: filter not-taken, sort travel, search “Udaipur”.')).toBeVisible();
  });

  test('passes axe (WCAG 2.2 AA) closed, with a dialog open, at phone width and at 200% zoom width', async ({ page }) => {
    // Four full-page axe runs on a long page: more time than the default 30 s on a loaded machine.
    test.setTimeout(120_000);
    await openRedesign(page);
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole('button', { name: 'Open confirm (required reason)' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.waitForTimeout(400);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
    await page.keyboard.press('Escape');

    for (const width of [390, 640]) {
      await page.setViewportSize({ width, height: 844 });
      await page.reload({ waitUntil: 'networkidle' });
      const [scrollWidth, clientWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(scrollWidth, `no sideways page scroll at ${width}px`).toBeLessThanOrEqual(clientWidth);
      results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations).toEqual([]);
    }
  });

  test('keyboard focus is always visible (2px brand outline) on every new part', async ({ page }) => {
    await openRedesign(page);
    const checked = new Set<string>();
    let previous = '';
    for (let i = 0; i < 120; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          key: `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}#${el.id}`,
          inMain: Boolean(el.closest('main')),
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
          outlineColor: style.outlineColor,
        };
      });
      if (!info || !info.inMain || info.key === previous) continue;
      previous = info.key;
      checked.add(info.key);
      const ring = info.outlineStyle === 'solid' && info.outlineWidth >= 2 && ['rgb(0, 74, 173)', 'rgb(185, 28, 28)'].includes(info.outlineColor);
      expect(ring, `visible focus on ${info.key}: ${JSON.stringify(info)}`).toBe(true);
    }
    expect(checked.size).toBeGreaterThan(40);
  });
});
