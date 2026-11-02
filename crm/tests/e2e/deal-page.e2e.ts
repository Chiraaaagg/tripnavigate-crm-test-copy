import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';

/**
 * Deal page through the design preview states (synthetic props). Direction A
 * Batch 1 workspace (DE-02): header with one primary action per booking state,
 * server-rendered link tabs with only the open tab rendered, Overview without
 * money, Money only for price readers, grouped History, Documents, per-tab
 * errors; plus not-found, could-not-load, the loading skeleton, accessibility,
 * reflow, focus, money per role (every tab and the raw page source) and the
 * style policy. The hotel booking panel keeps its markup on Services and tasks.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const DEAL_STATES = [
  'deal-page-bitrix-booking',
  'deal-page-purchase-stale',
  'deal-page-waiting',
  'deal-page-long-title',
  'deal-detail-sales',
  'deal-detail-purchase',
  'deal-detail-bitrix',
  'deal-detail-bitrix-stale',
  'deal-detail-commercial-not-recorded',
  'intake-deal-sales',
  'intake-deal-purchase',
  'booking-none',
  'booking-draft-needs-repair',
  'booking-draft-read-only',
  'booking-confirmed-taken',
  'booking-unavailable',
  'deal-not-found',
  'deal-loading',
  // Direction A Batch 1 workspace (19 October 2026): tabs, roles, states and per-tab errors.
  'deal-page-bitrix-booking-overview',
  'deal-page-bitrix-booking-money',
  'deal-detail-commercial-not-recorded-money',
  'ws-deal-sales',
  'ws-deal-sales-services',
  'ws-deal-sales-quotations',
  'ws-deal-sales-documents',
  'ws-deal-sales-money',
  'ws-deal-sales-history',
  'ws-deal-purchase',
  'ws-deal-purchase-history',
  'ws-deal-purchase-documents',
  'ws-deal-noprice',
  'ws-deal-manager',
  'ws-deal-state-not-started',
  'ws-deal-state-returned',
  'ws-deal-state-lost',
  'ws-deal-state-could-not-load',
  'ws-deal-state-waiting-owner-stale',
  'ws-deal-state-test-record',
  'ws-deal-error-history',
  'ws-deal-error-documents',
  'ws-deal-error-services',
];

async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

async function noHorizontalScroll(page: Page, label: string) {
  const sizes = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      // The content area too: an overflow clipped or scrolled inside main would not show on the page.
      main: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth } : null,
    };
  });
  expect(sizes.page.scrollWidth, label).toBeLessThanOrEqual(sizes.page.clientWidth);
  if (sizes.main) expect(sizes.main.scrollWidth, `${label} (main)`).toBeLessThanOrEqual(sizes.main.clientWidth);
}

async function open(page: Page, state: string) {
  const response = await page.goto(`/preview/${state}`, { waitUntil: 'networkidle' });
  expect(response?.status(), state).toBe(200);
}

/** Focus by keyboard (Shift+Tab, Tab) and return the outline plus any clipping ancestor up to main. */
async function keyboardFocusOutline(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
  return target.evaluate((el) => {
    const s = getComputedStyle(el);
    const offset = parseFloat(s.outlineOffset);
    const width = parseFloat(s.outlineWidth);
    const box = el.getBoundingClientRect();
    const outer = { left: box.left - offset - width, top: box.top - offset - width, right: box.right + offset + width, bottom: box.bottom + offset + width };
    const clipped: string[] = [];
    for (let a = el.parentElement; a && a.tagName !== 'MAIN'; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
      const r = a.getBoundingClientRect();
      if (outer.left < r.left || outer.top < r.top || outer.right > r.right || outer.bottom > r.bottom) clipped.push(`${a.tagName}.${a.className}`);
    }
    return { style: s.outlineStyle, width, color: s.outlineColor, clipped };
  });
}

const FOCUS_RING = { style: 'solid', width: 2, color: 'rgb(0, 74, 173)', clipped: [] };

test.describe('Deal page: accessibility and reflow', () => {
  for (const state of DEAL_STATES) {
    test(`axe clean and no sideways page scroll at 1440, 390, 320 (reflow) and 1280 at 200% zoom: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      // 390: the phone layout. 320 x 800: WCAG 1.4.10 reflow width. 640 x 400: a 1280 x 800
      // window at 200% browser zoom (same CSS pixel viewport). 768: tablet, where the fact cards
      // go two per row. 1024 and 1280: small laptops, either side of the two-column switch (xl).
      for (const size of [
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 320, height: 800 },
        { width: 640, height: 400 },
        { width: 1024, height: 768 },
        { width: 1280, height: 800 },
      ]) {
        await page.setViewportSize(size);
        await open(page, state);
        await noHorizontalScroll(page, `${state} at ${size.width}x${size.height}`);
        expect(await axe(page), `${state} at ${size.width}x${size.height}`).toEqual([]);
      }
    });
  }

  test('status pills never cut their words short at 320 px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    for (const state of ['ws-deal-state-waiting-owner-stale', 'ws-deal-state-returned', 'booking-unavailable', 'deal-detail-sales']) {
      await open(page, state);
      const pills = page.locator('main [data-slot="status-badge"] > span');
      expect(await pills.count(), state).toBeGreaterThan(0);
      const cut = await pills.evaluateAll((spans) =>
        spans.filter((s) => s.scrollWidth > s.clientWidth + 1 || s.scrollHeight > s.clientHeight + 1).map((s) => s.textContent),
      );
      expect(cut, state).toEqual([]);
    }
  });

  test('the could-not-load status is a wrapping line, not a one-line truncated pill', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page, 'booking-unavailable');
    const words = page.getByRole('region', { name: 'Hotel booking' }).locator('[data-slot="status-badge"] > span');
    const style = await words.evaluate((el) => {
      const s = getComputedStyle(el);
      return { whiteSpace: s.whiteSpace, textOverflow: s.textOverflow, overflowWrap: s.overflowWrap };
    });
    expect(style).toEqual({ whiteSpace: 'normal', textOverflow: 'clip', overflowWrap: 'anywhere' });
    // Every other pill on the page keeps the shared one-line style.
    await open(page, 'deal-detail-sales');
    expect(await page.locator('main [data-slot="status-badge"] > span').first().evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
  });

  test('long unbroken title, owner and stage wrap inside the page at 320 px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page, 'deal-page-long-title');
    await noHorizontalScroll(page, 'deal-page-long-title at 320');
    // Where the text itself ends (a Range), not the element box: an unbroken word can spill out of its box.
    const spill = await page.evaluate(() => {
      const main = document.querySelector('main')!.getBoundingClientRect();
      const header = document.querySelector('[data-slot="page-header"]')!;
      const out: string[] = [];
      for (const el of [header.querySelector('h1')!, ...header.querySelectorAll('p, span')]) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        if (r.width > 0 && (r.right > main.right + 0.5 || r.left < main.left - 0.5)) out.push((el.textContent ?? '').slice(0, 40));
      }
      return out;
    });
    expect(spill).toEqual([]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'SyntheticHoneymoonAndamanHavelockNeilPortBlairSixNightsWithFerriesAndTransfersIncluded',
    );
  });
});

test.describe('Deal page: header (P-HEADER)', () => {
  test('customer and trip in the one h1, reference above, stage, owner, From lead and live status under it', async ({ page }) => {
    await open(page, 'deal-page-bitrix-booking');
    const header = page.locator('[data-slot="page-header"]');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Synthetic honeymoon, Andaman (6 nights)');
    await expect(header.locator('p').first()).toHaveText('BX-900420');
    await expect(header).toContainText('Stage:Quote sent');
    await expect(header).toContainText('Owner: You');
    await expect(header.getByRole('link', { name: 'BXL-700311' })).toHaveAttribute('href', '/app/leads/c6000000-0000-4000-8000-000000000001');
    await expect(header).toContainText('From lead BXL-700311');
    // Not colour alone (WCAG 1.4.1): the link is underlined.
    expect(await header.getByRole('link', { name: 'BXL-700311' }).evaluate((a) => getComputedStyle(a).textDecorationLine)).toBe('underline');
    await expect(header.getByRole('status')).toHaveText(/Live/);
    // The live region holds only the indicator, never a link.
    await expect(header.getByRole('status').getByRole('link')).toHaveCount(0);
    // A fresh Bitrix deal shows no late or test-record marker: the header's only badge is the status word.
    await expect(page.getByRole('main')).not.toContainText(/Not updated from Bitrix|Test record/);
    await expect(header.locator('[data-slot="status-badge"]')).toHaveCount(1);
    await expect(header.locator('[data-slot="status-badge"]')).toHaveText('Booking status: Hotel booking');
    await expect(page.getByRole('link', { name: 'Back to deals' })).toHaveAttribute('href', '/app/deals');
  });

  test('statuses are words with an icon: booking status, waiting for owner, test record; late is a warning line', async ({ page }) => {
    const cases: Array<[string, string]> = [
      ['ws-deal-state-returned', 'Returned by Accounts'],
      ['ws-deal-state-waiting-owner-stale', 'Waiting for owner'],
      ['deal-detail-sales', 'Test record (not from Bitrix)'],
      ['ws-deal-state-could-not-load', 'Could not load'],
      ['ws-deal-state-confirmed', 'All services confirmed'],
    ];
    for (const [state, word] of cases) {
      await open(page, state);
      const pill = page.locator('[data-slot="page-header"] [data-slot="status-badge"]', { hasText: word });
      await expect(pill, state).toBeVisible();
      await expect(pill.locator('svg[aria-hidden="true"]'), state).toHaveCount(1);
    }
    await open(page, 'ws-deal-state-waiting-owner-stale');
    await expect(page.locator('[data-slot="page-header"]')).not.toContainText('Owner:');
    const late = page.getByRole('main').getByRole('note').filter({ hasText: 'Not updated from Bitrix for over a day' });
    await expect(late).toContainText('Check the stage in Bitrix before you rely on it.');
    await expect(late.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await open(page, 'deal-page-purchase-stale');
    await expect(page.locator('[data-slot="page-header"]')).toContainText('Owner: Synthetic Sales Delhi C');
  });

  test('exactly one primary action per booking state (copy §16.3); none when the viewer does not act next', async ({ page }) => {
    const cases: Array<[string, string | null]> = [
      ['ws-deal-state-not-started', 'Start booking'],
      ['ws-deal-state-quotation-accepted', 'Start booking from quotation'],
      ['ws-deal-sales', 'Continue booking'],
      ['ws-deal-state-ready', 'Review and submit'],
      ['ws-deal-state-waiting', 'View booking'],
      ['ws-deal-state-returned', 'Fix and send again'],
      ['ws-deal-state-arranged', 'See team tasks'],
      ['ws-deal-state-confirmed', 'View booking'],
      ['ws-deal-state-lost', 'View booking'],
      ['ws-deal-state-hotel-legacy', 'Open hotel booking'],
      ['ws-deal-state-not-started-read-only', null],
      ['ws-deal-state-could-not-load', null],
    ];
    for (const [state, label] of cases) {
      await open(page, state);
      const primary = page.locator('[data-slot="page-header"] [data-slot="deal-primary"]');
      if (label === null) {
        await expect(primary, state).toHaveCount(0);
        await expect(page.locator('[data-slot="deal-next"]'), state).toBeVisible();
      } else {
        await expect(primary.getByRole(state === 'ws-deal-state-not-started' ? 'button' : 'link', { name: label, exact: true }), state).toBeVisible();
        expect(await page.locator('[data-slot="page-header"] .bg-brand-strong').count(), state).toBe(1);
      }
    }
    await open(page, 'ws-deal-state-not-started');
    await expect(page.getByRole('main')).toContainText('Starts the booking form. Nothing is booked or paid.');
    await expect(page.getByRole('main')).toContainText('Waiting for Won - Payment Received');
    await open(page, 'ws-deal-state-could-not-load');
    await expect(page.getByRole('main')).toContainText('Booking did not load. Nothing was changed. Reload the page.');
    await expect(page.getByRole('main')).not.toContainText('Not started');
  });

  test('Quotations tab with the real cards: exactly one primary on the page; "Create quotation" is secondary (Echo M1)', async ({ page }) => {
    await open(page, 'ws-deal-sales-quotations');
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Create quotation' })).toBeVisible();
    expect(await main.locator('a.bg-brand-strong, button.bg-brand-strong').count()).toBe(1);
    await expect(main.locator('[data-slot="deal-primary"]').getByRole('link', { name: 'Continue booking' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Create quotation' })).not.toHaveClass(/bg-brand-strong/);
  });

  test('returned by Accounts: the reason under the title when shared, an honest line when not', async ({ page }) => {
    await open(page, 'ws-deal-state-returned');
    await expect(page.getByRole('main').getByRole('note').filter({ hasText: 'Returned by Accounts' })).toContainText('Reason: Synthetic: add the second traveller’s date of birth.');
    await open(page, 'ws-deal-state-returned-reason-hidden');
    await expect(page.getByRole('main')).toContainText('Accounts did not share the reason for this return with Sales.');
  });

  test('lost in Bitrix: read-only line, no way to change the booking', async ({ page }) => {
    await open(page, 'ws-deal-state-lost');
    await expect(page.getByRole('main')).toContainText('This deal is lost or rejected in Bitrix. You can read the booking; you cannot change it.');
  });
});

test.describe('Deal page: tabs (P-TABS)', () => {
  test('server-rendered link tabs in DA-10 order, current marked, never a count', async ({ page }) => {
    await open(page, 'ws-deal-sales-money');
    const tabs = page.getByRole('navigation', { name: 'Deal sections' });
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Services and tasks', 'Quotations', 'Documents', 'Money', 'History']);
    await expect(tabs.getByRole('link', { name: 'Money' })).toHaveAttribute('aria-current', 'page');
    await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/preview/ws-deal-sales');
    expect(await tabs.innerText()).not.toMatch(/\d/);
  });

  test('only the open tab is rendered: other tabs’ content is not in the page source', async ({ page }) => {
    const overview = await (await page.request.get('/preview/ws-deal-sales')).text();
    expect(overview).toContain('id="deal-overview-heading"');
    expect(overview).not.toMatch(/deal-money-heading|deal-history-heading|deal-documents-heading/);
    // A price reader's Overview carries no money (prototype's "Selling price" row not adopted).
    expect(overview).not.toMatch(/₹|sellingTotal|estimatedMargin|Selling price/);
  });

  test('Purchase and Sales without price access have no Money tab; Purchase has no Quotations tab and no From lead', async ({ page }) => {
    await open(page, 'ws-deal-purchase');
    const tabs = page.getByRole('navigation', { name: 'Deal sections' });
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Services and tasks', 'Documents', 'History']);
    await expect(page.locator('[data-slot="page-header"]')).not.toContainText('From lead');
    await open(page, 'ws-deal-noprice');
    await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link')).toHaveText(['Overview', 'Services and tasks', 'Quotations', 'Documents', 'History']);
  });

  test('a tab that could not load says so; the header and tabs stay (SH-06)', async ({ page }) => {
    const cases: Array<[string, string]> = [
      ['ws-deal-error-history', 'History did not load. Nothing was changed.'],
      ['ws-deal-error-documents', 'Documents did not load. Nothing was changed.'],
    ];
    for (const [state, text] of cases) {
      await open(page, state);
      await expect(page.getByRole('main').getByRole('status').filter({ hasText: text }), state).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 }), state).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Deal sections' }), state).toBeVisible();
      await expect(page.getByRole('main'), state).not.toContainText(/No history you can see|No documents you can open/);
    }
    // A failed services read: the route places today's could-not-load card, never an empty state.
    await open(page, 'ws-deal-error-services');
    await expect(page.getByRole('region', { name: 'Services sold' })).toContainText('Could not load the services');
    await expect(page.getByRole('main')).not.toContainText(/No services yet|Nothing to show here yet/);
  });
});

test.describe('Deal page: tab content', () => {
  test('Overview: trip, branch, team, created; why visible and Bitrix facts on demand; no control', async ({ page }) => {
    await open(page, 'deal-page-bitrix-booking-overview');
    const overview = page.getByRole('region', { name: 'Overview' });
    await expect(overview.getByRole('term').first()).toHaveText('Trip');
    await expect(overview).toContainText('Delhi');
    // One date format everywhere (Echo L9); a colleague is named by role only (DEC-52 covers the owner only).
    await expect(overview).toContainText('1 Oct 2026');
    await expect(overview.getByRole('listitem')).toHaveText(['Sales: You', 'Purchase: a colleague']);
    await overview.locator('summary').click();
    await expect(overview).toContainText('Why you can see this deal');
    await expect(overview).toContainText('You own this deal.');
    await expect(overview).toContainText('#900420');
    await expect(overview).toContainText('Last checked with Bitrix');
    await expect(overview).toContainText('Last change received');
    await expect(overview).toContainText('Title, stage and salesperson come from Bitrix. Change them there.');
    await expect(overview.getByRole('button')).toHaveCount(0);
    // The Bitrix facts are read-only: no control and no link inside them.
    await expect(overview.locator('[data-slot="deal-details"]').getByRole('link')).toHaveCount(0);
    await open(page, 'deal-detail-bitrix');
    await expect(page.getByRole('region', { name: 'Overview' })).toContainText('No one assigned yet');
  });

  test('Services and tasks: the hotel booking panel keeps its own markup and its primary action', async ({ page }) => {
    await open(page, 'deal-page-bitrix-booking');
    const panel = page.locator('#hotel-booking');
    await expect(panel).toHaveClass(/work-panel/);
    await expect(panel.getByRole('button', { name: 'Review and confirm' })).toBeVisible();
    await expect(panel.locator('[data-slot="next-line"]')).toContainText('Next: review the details and confirm to create the Purchase task');
  });

  test('could not load the booking: words, what to do and who to tell, nothing pretends to be empty', async ({ page }) => {
    await open(page, 'booking-unavailable');
    const region = page.getByRole('region', { name: 'Hotel booking' });
    await expect(region.locator('[data-slot="status-badge"]')).toHaveText('Booking status: Did not load');
    // Echo-B L2: the next step and who acts are in the one sentence (reload; then the admin), not a "Next:" line
    // that would claim a booking step the page could not read.
    await expect(region).toContainText('The hotel booking did not load. Nothing was changed. Reload the page. If it keeps happening, tell your admin.');
    await expect(region.locator('[data-slot="next-line"]')).toHaveCount(0);
    await expect(region).not.toContainText(/no booking|not started/i);
  });

  test('History: grouped with headings, newest first within each group, no amounts; Purchase gets an honest empty line', async ({ page }) => {
    await open(page, 'ws-deal-sales-history');
    const history = page.getByRole('region', { name: 'History' });
    await expect(history.getByRole('heading', { level: 3 })).toHaveText(['Booking versions and Accounts reviews', 'Quotations', 'Reported payments']);
    await expect(history).toContainText('Each group lists its newest event first.');
    await expect(history).toContainText('Booking version 1: Submitted');
    await expect(history).toContainText('Version 1: Returned by Accounts');
    await expect(history).toContainText('Reason: Synthetic: add the second traveller’s date of birth.');
    await expect(history).not.toContainText('₹');
    await open(page, 'ws-deal-purchase-history');
    await expect(page.getByRole('region', { name: 'History' })).toContainText(
      'No history you can see on this deal yet.',
    );
  });

  test('Documents: only files the viewer may open, each linking to its route, described in words', async ({ page }) => {
    await open(page, 'ws-deal-sales-documents');
    const docs = page.getByRole('region', { name: 'Documents' });
    await expect(docs.getByRole('link')).toHaveText(['synthetic-acceptance.png', 'synthetic-id-traveller-1.pdf', 'synthetic-itinerary.pdf']);
    await expect(docs).toContainText('Customer’s acceptance message · quotation TQ-1042 version 1');
    await expect(docs).toContainText('ID proof · traveller 1');
    await open(page, 'ws-deal-purchase-documents');
    const purchase = page.getByRole('region', { name: 'Documents' });
    await expect(purchase.getByRole('link')).toHaveText(['synthetic-id-traveller-1.pdf']);
    await expect(purchase).not.toContainText(/acceptance|payment proof/i);
  });

  test('not found: one honest message in a status, the way back outside it', async ({ page }) => {
    await open(page, 'deal-not-found');
    const main = page.getByRole('main');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deal not available');
    const status = main.getByRole('status');
    await expect(status).toHaveText('This deal does not exist, or it is not visible to you.');
    await expect(status.getByRole('link')).toHaveCount(0);
    const back = main.getByRole('link', { name: 'Back to deals' });
    await expect(back).toHaveAttribute('href', '/app/deals');
    expect(await back.evaluate((a) => a.closest('[role="status"]') === null)).toBe(true);
  });
});

test.describe('Deal page: money and proof per role', () => {
  const PURCHASE_STATES = [
    'deal-page-purchase-stale',
    'deal-detail-purchase',
    'intake-deal-purchase',
    'ws-deal-purchase',
    'ws-deal-purchase-services',
    'ws-deal-purchase-documents',
    'ws-deal-purchase-history',
    // The preview of "?tab=money" from Purchase: it renders Overview, never money.
    'ws-deal-purchase-money',
  ];

  test('Purchase never sees a selling price, margin or customer payment proof, on any tab or in the page source', async ({ page }) => {
    for (const state of PURCHASE_STATES) {
      await open(page, state);
      const main = page.getByRole('main');
      await expect(main, state).not.toContainText('₹');
      await expect(main, state).not.toContainText(/estimated margin|selling|payment proof|proof the customer accepted/i);
      await expect(main.locator('#hotel-booking'), state).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Money' }), state).toHaveCount(0);
      // The raw page source carries no amount either (nothing hidden only by CSS).
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html, state).not.toMatch(/₹|estimatedMargin|sellingTotal/);
    }
    await open(page, 'ws-deal-purchase-money');
    await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  test('Sales without price access: no Money tab and no amount anywhere', async ({ page }) => {
    for (const state of ['ws-deal-noprice', 'ws-deal-noprice-history', 'ws-deal-noprice-documents']) {
      await open(page, state);
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html, state).not.toMatch(/₹|estimatedMargin|sellingTotal/);
      await expect(page.getByRole('main'), state).not.toContainText('Reported payments');
    }
  });

  for (const size of [
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 800 },
  ]) {
    test(`amounts are never split across lines at ${size.width} px`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, 'deal-page-bitrix-booking-money');
      const lines = await page
        .getByRole('region', { name: 'Deal value (test record only)' })
        .getByRole('definition')
        .evaluateAll((dds) =>
          dds.map((dd) => {
            const range = document.createRange();
            range.selectNodeContents(dd);
            const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
            return { text: dd.textContent, lines: tops.size };
          }),
        );
      expect(lines).toEqual([
        { text: '₹1,23,456.00', lines: 1 },
        { text: '₹11,111.00', lines: 1 },
      ]);
    });
  }

  test('Sales owner sees the deal value and margin on the Money tab, with the claims summary words', async ({ page }) => {
    await open(page, 'deal-page-bitrix-booking-money');
    const value = page.getByRole('region', { name: 'Deal value (test record only)' });
    await expect(value).toContainText('Test figures. No tax is calculated here.');
    await expect(value.getByRole('definition')).toHaveText(['₹1,23,456.00', '₹11,111.00']);
    await open(page, 'ws-deal-sales-money');
    const money = page.getByRole('region', { name: 'Money' });
    await expect(money).toContainText('Reported, not checked (not money)');
    await expect(money).toContainText('Checked by Accounts');
    await expect(money).toContainText('Still to pay (based on checked money)');
    // DA-119: the list holds every reported payment on the deal, not only the viewer's.
    await expect(money.getByRole('list', { name: 'Reported payments on this deal' })).toBeVisible();
    await expect(money).toContainText('Receipts and cheques are handled by Accounts and are not listed here.');
    await expect(money).not.toContainText(/cheque number|receipt number|company account/i);
  });

  test('a reader allowed to see money on a deal without a price is told nothing is recorded yet, never "hidden"', async ({ page }) => {
    await open(page, 'deal-detail-commercial-not-recorded-money');
    const money = page.getByRole('region', { name: 'Money' });
    await expect(money).toContainText('No money recorded on this deal yet. The selling total shows here once the booking has a price.');
    await expect(money).not.toContainText('Hidden for your role');
    await expect(page.getByRole('region', { name: 'Deal value (test record only)' })).toHaveCount(0);
  });
});

test.describe('Deal page: layout', () => {
  test('phone (375 px): the one primary action, then the Next line, then the tabs; no sideways page scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, 'ws-deal-sales');
    const primary = (await page.locator('[data-slot="deal-primary"]').boundingBox())!;
    const next = (await page.locator('[data-slot="deal-next"]').boundingBox())!;
    const tabs = (await page.getByRole('navigation', { name: 'Deal sections' }).boundingBox())!;
    expect(next.y).toBeGreaterThan(primary.y);
    expect(tabs.y).toBeGreaterThan(next.y);
    expect(primary.x + primary.width).toBeLessThanOrEqual(375);
    await noHorizontalScroll(page, 'ws-deal-sales at 375');
  });

  for (const size of [
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
  ]) {
    test(`small laptop (${size.width} px): the hotel booking panel keeps its width on Services and tasks`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, 'deal-page-bitrix-booking');
      const booking = (await page.locator('#hotel-booking').boundingBox())!;
      expect(booking.width, 'booking panel width').toBeGreaterThanOrEqual(600);
    });
  }
});

test.describe('Deal page: focus', () => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`back link, Lead link, tabs and the not-found button show a full 2px brand outline at ${size.width}px`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, 'deal-page-bitrix-booking');
      expect(await keyboardFocusOutline(page, page.getByRole('main').getByRole('link', { name: 'Back to deals' }))).toEqual(FOCUS_RING);
      expect(await keyboardFocusOutline(page, page.getByRole('link', { name: 'BXL-700311' }))).toEqual(FOCUS_RING);
      expect(await keyboardFocusOutline(page, page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Overview' }))).toEqual(FOCUS_RING);
      await open(page, 'deal-not-found');
      expect(await keyboardFocusOutline(page, page.getByRole('main').getByRole('link', { name: 'Back to deals' }))).toEqual(FOCUS_RING);
    });
  }

  test('keyboard order: back link, Lead link, the primary action, then the tabs', async ({ page }) => {
    await open(page, 'ws-deal-sales');
    await page.getByRole('main').getByRole('link', { name: 'Back to deals' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'BXL-700601' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Continue booking' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Overview' })).toBeFocused();
  });
});

test.describe('Deal page: loading state', () => {
  test('announces loading once, keeps one h1, and the shapes stop moving with reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const state of ['deal-loading', 'booking-loading']) {
      await open(page, state);
      const main = page.locator('main');
      await expect(main.getByRole('status')).toHaveText('Loading deal…');
      await expect(main.locator('[role="status"][aria-busy]')).toHaveCount(0);
      await expect(main.locator('[aria-busy="true"]')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deal');
      const shapes = main.locator('[data-slot="skeleton"]');
      expect(await shapes.count()).toBeGreaterThan(8);
      await expect(shapes.first()).toHaveAttribute('aria-hidden', 'true');
      expect(await shapes.first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    }
  });
});

test.describe('Deal page: production style policy', () => {
  test('every deal page state renders with zero CSP violations', async ({ browser }) => {
    // Many states in one test: the same budget as the shared cspSuite (the default 30 s was at its edge).
    test.setTimeout(300_000);
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => DEAL_STATES.some((s) => url.pathname === `/preview/${s}`));
    const { violations } = await trackViolations(context);
    const page = await context.newPage();
    for (const state of DEAL_STATES) {
      await open(page, state);
      // Server-rendered markup of the whole document (not only main): no style attribute anywhere.
      const html = await (await page.request.get(`/preview/${state}`)).text();
      expect(html.match(/<[a-z][^>]*\sstyle="/gi), `${state}: server-rendered style attributes`).toBeNull();
      // And none in the live page markup either, except Next.js's own route announcer and the
      // development overlay: their style attributes are set in the browser after loading, they are
      // not in the server HTML checked above, and the CSP violation listener in this test stays
      // empty with them present.
      const live = await page.evaluate(() =>
        [...document.querySelectorAll('[style]')]
          .filter((el) => !el.closest('next-route-announcer, nextjs-portal, [data-nextjs-dev-overlay]'))
          .map((el) => el.outerHTML.slice(0, 120)),
      );
      expect(live, state).toEqual([]);
    }
    expect(applied.length).toBe(DEAL_STATES.length);
    expect(violations).toEqual([]);
    await context.close();
  });
});
