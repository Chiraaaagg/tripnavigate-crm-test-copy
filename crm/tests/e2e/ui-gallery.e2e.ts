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
