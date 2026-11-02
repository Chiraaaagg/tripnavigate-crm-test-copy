import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';

/**
 * Deals list through the design preview states (synthetic props). Direction A
 * Batch 1 (DE-01): owner and stage columns, details on demand, filter chips
 * with exact counts and their scope, "Search this page", a true pager, and the
 * freshness line apart from the live indicator. Also the layout: table on
 * desktop, labelled cards on a 390 px phone, accessible names, focus, loading
 * and the style policy.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const DEALS_STATES = [
  'deals-mixed',
  'deals-sales',
  'deals-manager-branch-grant',
  'deals-empty',
  'deals-bitrix-source',
  'deals-list-later-page',
  'deals-list-end',
  'deals-list-past-end',
  'intake-deals-purchase',
  'deals-loading',
  // Direction A Batch 1 (19 October 2026)
  'deals-filter-owned-empty',
  'deals-counts-unavailable',
  'deals-accounts-empty',
  'deals-super-admin-empty',
];

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

test.describe('Deals list: accessibility', () => {
  for (const state of DEALS_STATES) {
    test(`axe clean and no sideways page scroll at 1440, 390, 320 (reflow) and 1280 at 200% zoom: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);

      // 390: the phone layout. 320 x 800: WCAG 1.4.10 reflow width. 640 x 400: a 1280 x 800
      // window at 200% browser zoom (same CSS pixel viewport). The data table itself may
      // scroll inside its own focusable region (allowed for tables); the page may not.
      for (const size of [
        { width: 390, height: 844 },
        { width: 320, height: 800 },
        { width: 640, height: 400 },
      ]) {
        await page.setViewportSize(size);
        await open(page, state);
        await noHorizontalScroll(page);
        expect(await axe(page), `${state} at ${size.width}x${size.height}`).toEqual([]);
      }
    });
  }
});

test.describe('Deals list: layout', () => {
  test('desktop: a captioned table with five column headers (Batch 1: owner instead of "why you can see it", details on demand)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'deals-mixed');
    const table = page.getByRole('table', { name: '1–5 of 107 deals' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Reference', 'Customer and trip', 'Stage', 'Owner', 'Details']);
    await expect(table.getByRole('columnheader').first()).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(6);
  });

  test('phone (390 px): rows become labelled cards; headers stay for screen readers only', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'deals-mixed');
    const table = page.getByRole('table');
    // The header row is visually hidden (sr-only: 1px box, clipped), not removed:
    // the column headers stay in the accessibility tree.
    const thead = table.locator('thead');
    const hidden = await thead.evaluate((el) => {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const clipped = s.clip === 'rect(0px, 0px, 0px, 0px)' || (s.clipPath !== 'none' && s.clipPath !== '');
      return { position: s.position, clipped, overflow: s.overflow, width: box.width, height: box.height, display: s.display };
    });
    expect(hidden.display).not.toBe('none');
    expect(hidden.position).toBe('absolute');
    expect(hidden.clipped).toBe(true);
    expect(hidden.overflow).toBe('hidden');
    expect(hidden.width).toBeLessThanOrEqual(1);
    expect(hidden.height).toBeLessThanOrEqual(1);
    await expect(table.getByRole('columnheader')).toHaveText(['Reference', 'Customer and trip', 'Stage', 'Owner', 'Details']);
    expect(await table.getByRole('columnheader').count()).toBe(5);
    const firstRow = table.getByRole('row').nth(1);
    await expect(firstRow).toBeVisible();
    // Each value cell shows its column name before the value (the first cell is the card title).
    const labels = await firstRow.getByRole('cell').evaluateAll((cells) =>
      cells.map((c) => getComputedStyle(c, '::before').content.replace(/^"|"$/g, '')),
    );
    // The Details cell has no card label: its control says "Details" (Echo L4: never "Details Details").
    expect(labels).toEqual(['none', 'Customer and trip', 'Stage', 'Owner', '']);
    const box = await firstRow.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(390);
    // The order links stack and stay full width and tappable.
    const order = page.getByRole('group', { name: 'Order of deals' });
    await expect(order.getByRole('link', { name: 'Oldest first' })).toBeVisible();
  });
});

test.describe('Deals list: content, links and status words', () => {
  test('order control: current order marked, the other is a link back to page 1', async ({ page }) => {
    await open(page, 'deals-mixed');
    const order = page.getByRole('group', { name: 'Order of deals' });
    await expect(order.locator('[aria-current="true"]')).toHaveText('Newest first');
    await expect(order.getByRole('link', { name: 'Oldest first' })).toHaveAttribute('href', '/app/deals?sort=id_asc');
  });

  test('references link to the deal; statuses are words with an icon, not colour alone', async ({ page }) => {
    await open(page, 'deals-mixed');
    const table = page.getByRole('table');
    await expect(table.getByRole('link', { name: 'BX-900420' })).toHaveAttribute('href', '/app/deals/m1');
    const waiting = table.locator('[data-slot="status-badge"]', { hasText: 'Waiting for owner' });
    await expect(waiting).toBeVisible();
    await expect(waiting.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(table.locator('[data-slot="status-badge"]', { hasText: 'Not updated from Bitrix for over a day' })).toBeVisible();
    await expect(table.locator('[data-slot="status-badge"]', { hasText: 'Test record' })).toBeVisible();
    await expect(table).toContainText('Quote sent');
    // Unknown codes are never given an invented name (copy §16.7): fallback in the cell, code in Details.
    await expect(table).toContainText('Stage not recognised (code in details)');
    await expect(table.getByText('Bitrix code: C1:UC_SYN7. Reading Bitrix names is switched off.')).toBeHidden();
    await table.locator('summary', { hasText: 'Details for BX-900418' }).click();
    await expect(table.getByText('Bitrix code: C1:UC_SYN7. Reading Bitrix names is switched off.')).toBeVisible();
    await expect(table).toContainText('#900418');
    await expect(table).toContainText('You are assigned to this deal.');
    await expect(table).toContainText('Synthetic Sales Delhi B');
    await expect(table).toContainText('Another staff member');
    // DA-131: the list keeps one description line; the Bitrix-owns line lives once in the Deal's Details.
    await expect(page.getByRole('main')).not.toContainText('Stage and salesperson change only in Bitrix.');
    // DA-94a: a Manager cannot change the names switch: no names-off line (the cells and Details say it).
    await expect(page.getByRole('main')).not.toContainText('Bitrix names are');
  });

  test('pager: page count and next link keep the order', async ({ page }) => {
    await open(page, 'deals-mixed');
    const pager = page.getByRole('navigation', { name: 'Deal pages' });
    await expect(pager).toContainText('1–5 of 107 deals');
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/app/deals?page=2');
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveAttribute('rel', 'next');
    await expect(pager.getByRole('link', { name: /^Previous/ })).toHaveCount(0);
    await open(page, 'deals-list-later-page');
    await expect(page.getByRole('navigation', { name: 'Deal pages' }).getByRole('link', { name: 'Previous page' })).toHaveAttribute('rel', 'prev');
  });

  test('live indicator sits under the title as a status', async ({ page }) => {
    await open(page, 'deals-mixed');
    await expect(page.locator('[data-slot="page-header"]').getByRole('status')).toHaveText(/Live/);
  });

  test('empty list: one honest message and no table', async ({ page }) => {
    await open(page, 'deals-empty');
    const status = page.getByRole('main').getByRole('status');
    await expect(status.getByRole('heading', { level: 2, name: 'No deals to show' })).toBeVisible();
    await expect(status).toContainText('No deal is visible to you. Ask your manager if you expected to see one.');
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('empty page with other pages: the pager is shown, after and outside the status message', async ({ page }) => {
    await open(page, 'deals-list-past-end');
    const main = page.getByRole('main');
    const status = main.getByRole('status');
    await expect(status).toContainText('That was the last page');
    const pager = main.getByRole('navigation', { name: 'Deal pages' });
    await expect(pager).toBeVisible();
    await expect(pager).toContainText('No deals on this page (107 in total)');
    await expect(pager.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/app/deals?page=3');
    await expect(pager.getByRole('link', { name: /^Next/ })).toHaveCount(0);
    // Not inside the live region: the status announces only the message.
    await expect(status.getByRole('navigation')).toHaveCount(0);
    expect(await pager.evaluate((nav) => nav.closest('[role="status"]') === null)).toBe(true);
    // And it follows the message in reading order.
    const follows = await status.evaluate((s, navEl) => !!(s.compareDocumentPosition(navEl!) & Node.DOCUMENT_POSITION_FOLLOWING), await pager.elementHandle());
    expect(follows).toBe(true);
  });

  test('Purchase list shows no selling price, margin or payment proof', async ({ page }) => {
    await open(page, 'intake-deals-purchase');
    const main = page.getByRole('main');
    await expect(main.getByRole('table')).toBeVisible();
    await expect(main).not.toContainText('₹');
    await expect(main).not.toContainText(/margin|selling price|payment proof/i);
  });

  test('reference and order links show the design-system focus outline', async ({ page }) => {
    await open(page, 'deals-mixed');
    for (const link of [
      page.getByRole('group', { name: 'Order of deals' }).getByRole('link'),
      page.getByRole('table').getByRole('link', { name: 'BX-900420' }),
    ]) {
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      const outline = await link.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor };
      });
      expect(outline).toEqual({ style: 'solid', width: 2, color: 'rgb(0, 74, 173)' });
    }
  });
});

test.describe('Deals list: Batch 1 chips, search and freshness', () => {
  test('chips: exact counts, scope named, current chip marked; a failed count is words, never 0', async ({ page }) => {
    await open(page, 'deals-mixed');
    const chips = page.getByRole('navigation', { name: 'Filter deals' });
    await expect(chips.getByRole('link', { name: /All deals you can see \(107\)/ })).toHaveAttribute('aria-current', 'page');
    await expect(chips.getByRole('link', { name: /Owned by you \(12\)/ })).toHaveAttribute('href', '/app/deals?filter=owned');
    await expect(page.getByRole('main')).toContainText('Counts include all pages.');
    await expect(chips.getByRole('link', { name: /Assigned to you\s*,\s*owned by someone else\s*\(4\)/ })).toHaveAttribute('href', '/app/deals?filter=assigned');
    await open(page, 'deals-counts-unavailable');
    const failed = page.getByRole('navigation', { name: 'Filter deals' });
    await expect(failed).toContainText('(count unavailable)');
    await expect(failed).not.toContainText('(0)');
    await expect(page.getByRole('navigation', { name: 'Deal pages' })).toContainText('total not known');
  });

  test('search this page: says it searches this page only, hides other rows, honest no-match line', async ({ page }) => {
    await open(page, 'deals-mixed');
    const box = page.getByRole('searchbox', { name: 'Search this page' });
    await expect(box).toHaveAccessibleDescription(/Searches this page only\./);
    await expect(box).toHaveAttribute('placeholder', 'Name, trip or reference');
    await box.fill('kerala');
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2); // header + one match
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: '1 of 5 deals on this page match.' })).toBeVisible();
    await box.fill('no such trip');
    await expect(page.getByRole('main')).toContainText('No match on this page. Try Next page, or find the deal in Bitrix.');
    await box.fill('');
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(6);
  });

  test('freshness line and live indicator are separate; the live words never claim freshness', async ({ page }) => {
    await open(page, 'deals-mixed');
    const header = page.locator('[data-slot="page-header"]');
    await expect(header.locator('[data-slot="freshness"]')).toContainText('Bitrix data updated');
    await expect(header.getByRole('status')).toHaveText(/Live updates on/);
    await expect(header.getByRole('status')).not.toContainText('updated');
  });

  test('filtered empty and role empty states', async ({ page }) => {
    await open(page, 'deals-filter-owned-empty');
    await expect(page.getByRole('main').getByRole('status')).toContainText('Nothing matches this filter');
    await expect(page.getByRole('main').getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/app/deals');
    await open(page, 'deals-accounts-empty');
    await expect(page.getByRole('main').getByRole('status')).toContainText('Your Deal work is in Accounts.');
    await open(page, 'deals-super-admin-empty');
    await expect(page.getByRole('main').getByRole('status')).toContainText('only when you are given access');
  });
});

test.describe('Deals list: table region focus', () => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`the scrollable table region shows a full, unclipped focus outline at ${size.width}px`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, 'deals-mixed');
      const region = page.getByRole('region', { name: 'Deals table' });
      // Keyboard path: the last order link, then Tab into the table region.
      await page.getByRole('group', { name: 'Order of deals' }).getByRole('link').focus();
      await page.keyboard.press('Tab');
      await expect(region).toBeFocused();
      const result = await region.evaluate((el) => {
        const s = getComputedStyle(el);
        const offset = parseFloat(s.outlineOffset);
        const width = parseFloat(s.outlineWidth);
        const box = el.getBoundingClientRect();
        // The outline's outer edge on every side.
        const outer = { left: box.left - offset - width, top: box.top - offset - width, right: box.right + offset + width, bottom: box.bottom + offset + width };
        // Any ancestor (up to main) that clips overflow must contain the whole outline.
        const clipped: string[] = [];
        for (let a = el.parentElement; a && a.tagName !== 'MAIN'; a = a.parentElement) {
          const as = getComputedStyle(a);
          if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
          const r = a.getBoundingClientRect();
          if (outer.left < r.left || outer.top < r.top || outer.right > r.right || outer.bottom > r.bottom) {
            clipped.push(`${a.tagName}.${a.className}`);
          }
        }
        return { style: s.outlineStyle, width, color: s.outlineColor, clipped };
      });
      expect(result).toEqual({ style: 'solid', width: 2, color: 'rgb(0, 74, 173)', clipped: [] });
    });
  }
});

test.describe('Deals list: loading state', () => {
  test('announces loading once, shows no table, and the shapes stop moving with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'deals-loading');
    await expect(page.getByRole('status').filter({ hasText: 'Loading deals…' })).toBeVisible();
    // One level-1 heading, from DealsListLoading itself (the route loading file renders only that).
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deals');
    await expect(page.getByRole('table')).toHaveCount(0);
    const shapes = page.locator('main [data-slot="skeleton"]');
    expect(await shapes.count()).toBeGreaterThan(5);
    await expect(shapes.first()).toHaveAttribute('aria-hidden', 'true');
    expect(await shapes.first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });
});

test.describe('Deals list: production style policy', () => {
  test('every Deals list state renders with zero CSP violations', async ({ browser }) => {
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => DEALS_STATES.some((s) => url.pathname === `/preview/${s}`));
    const { violations } = await trackViolations(context);
    const page = await context.newPage();
    for (const state of DEALS_STATES) {
      await open(page, state);
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html, `${state}: no server-rendered style attribute in main`).not.toMatch(/<main[\s\S]*<[a-z][^>]*\sstyle="[\s\S]*<\/main>/i);
    }
    expect(applied.length).toBe(DEALS_STATES.length);
    expect(violations).toEqual([]);
    await context.close();
  });
});
