import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Phase 6 approved import list (manifest) and Bitrix Lead provenance, through
 * the design-preview gallery (synthetic props, no Supabase, no Bitrix). Not
 * evidence of a real intake: lead access is enforced by crm_leads RLS and
 * integration.manage server-side; these checks cover what each view renders.
 */

const states = [
  'p6-sync-scope-active',
  'p6-sync-scope-complete',
  'p6-sync-scope-failed',
  'p6-sync-scope-stale',
  'p6-sync-scope-never-synced',
  'p6-sync-scope-closed',
  'p6-sync-scope-none',
  'p6-sync-scope-switched-off',
  'p6-sync-scope-unavailable',
  'p6-sync-scope-changed',
  'p6-sync-purchase-denied',
  'p6-leads-sales',
  'p6-leads-limited',
  'p6-leads-page-middle',
  'p6-leads-page-last',
  'p6-leads-page-past-end',
  'p6-leads-manager',
  'p6-leads-empty',
  'p6-lead-sales',
  'p6-lead-raw-status-stale',
  'p6-lead-not-found',
  'p6-lead-purchase-denied',
  'p6-leads-purchase-denied',
  // Direction A Batch 1 (19 October 2026)
  'p6-lead-sales-quotations',
  'p6-lead-sales-bitrix',
  'p6-lead-raw-status-stale-bitrix',
  'p6-lead-admin-no-quotations',
  'p6-leads-mine-empty',
  'p6-leads-counts-unavailable',
];

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

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
  await page.goto(`/preview/${state}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
  await page.waitForLoadState('networkidle');
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const scopePanel = (page: Page) => page.getByRole('region', { name: 'Approved import list' });

test.describe('Phase 6 previews: accessibility on desktop, 390 px and 200% zoom', () => {
  for (const state of states) {
    test(`axe clean: ${state}`, async ({ page }) => {
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
    });
    test(`390 px, no sideways scroll: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
    });
  }

  for (const state of ['p6-sync-scope-active', 'p6-sync-scope-failed', 'p6-leads-sales', 'p6-leads-page-middle', 'p6-lead-raw-status-stale', 'p6-lead-not-found']) {
    test(`200% zoom keeps ${state} usable without sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width: 640, height: 900 });
      await open(page, state);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await noHorizontalScroll(page);
    });
  }
});

test.describe('Approved import list on the Bitrix sync page', () => {
  test('active list: Lead scope, CRM form source, frozen date and interval, counts and stop steps', async ({ page }) => {
    await open(page, 'p6-sync-scope-active');
    // With an import list the inbox mixes Leads and Deals, so page-level problems say "records".
    await expect(page.getByRole('region', { name: 'What needs fixing' })).toContainText(
      '2 records need a person to fix something before they can be copied.',
    );
    const panel = scopePanel(page);
    await expect(panel).toContainText('1 held for review');
    for (const text of [
      'Active',
      'Leads only',
      'CRM form (WEBFORM)',
      '4 Oct 2026 (India time)',
      'From 4 Oct 2026, 12:00 am IST up to, not including, 5 Oct 2026, 12:00 am IST',
      'Last successful sync',
      '5 of 8 approved',
      'by synthetic-operator',
    ]) {
      await expect(panel).toContainText(text);
    }
    const counts = panel.getByRole('definition').filter({ hasText: /^\d+$/ });
    await expect(counts).toHaveText(['8', '5', '1', '0', '2', '2']);
    await expect(panel.getByRole('progressbar')).toHaveAttribute('value', '5');
    await expect(panel.getByRole('note')).toContainText('1 of 8 approved leads are held for review and not copied yet.');
    await expect(panel.getByRole('note')).toContainText('Next:');
    const stop = panel.getByRole('heading', { name: 'How to stop intake' });
    await expect(stop).toBeVisible();
    await expect(panel).toContainText('Close the import list.');
    await expect(panel).toContainText('Or switch off the intake configuration');
    await expect(panel).toContainText('Nothing is deleted and nothing is written back to Bitrix.');
    // The page cannot create, widen or close the list: no control in the panel.
    await expect(panel.getByRole('button')).toHaveCount(0);
    await expect(panel.getByRole('textbox')).toHaveCount(0);
  });

  test('every scope state is named in words, never as healthy when records fail or wait', async ({ page }) => {
    const expected: Array<[string, string, string]> = [
      ['p6-sync-scope-complete', 'All 8 imported', 'Run the comparator with the manifest file'],
      ['p6-sync-scope-failed', '2 of 8 failed', '2 of 8 approved leads failed to copy.'],
      ['p6-sync-scope-stale', 'No successful sync for over 24 hours', '5 approved leads are not in the CRM yet'],
      ['p6-sync-scope-never-synced', 'No successful sync yet', 'nothing was copied so far'],
      ['p6-sync-scope-closed', 'Import list closed: nothing more is imported', 'No further Bitrix leads are copied.'],
      ['p6-sync-scope-none', 'No approved import list: nothing is imported', 'create the list with the manifest command'],
      ['p6-sync-scope-switched-off', 'List active, but intake is switched off', 'if intake was stopped on purpose, close the list too.'],
    ];
    for (const [state, pill, sentence] of expected) {
      await open(page, state);
      const panel = scopePanel(page);
      await expect(panel, state).toContainText(pill);
      await expect(panel.getByRole('note'), state).toContainText(sentence);
      await expect(panel.getByRole('note'), state).toContainText('Next:');
    }
    await open(page, 'p6-sync-scope-failed');
    await expect(scopePanel(page)).not.toContainText('All 8 imported');
    await open(page, 'p6-sync-scope-closed');
    await expect(page.getByRole('heading', { name: 'How to stop intake' })).toHaveCount(0);
  });

  test('sync rows name Lead or Deal; new reasons are plain sentences, no raw codes', async ({ page }) => {
    await open(page, 'p6-sync-scope-active');
    const table = page.getByRole('table', { name: /need attention/ });
    await expect(table.getByRole('columnheader', { name: 'Bitrix record' })).toBeVisible();
    const outside = table.getByRole('row').filter({ hasText: 'Lead #700601' });
    await expect(outside).toContainText('held for review and not copied');
    await expect(outside).toContainText('· an admin, with the owner');
    await expect(outside).toContainText('Next: check the record in Bitrix.');
    const unmapped = table.getByRole('row').filter({ hasText: 'Lead #700602' });
    await expect(unmapped).toContainText('The responsible person in Bitrix is not linked to a CRM staff member.');
    const excluded = table.getByRole('row').filter({ hasText: 'Lead #700603' });
    await expect(excluded).toContainText('not on the owner-approved import list');
    await expect(excluded).toContainText('Retry cannot add it.');
    await expect(excluded).toContainText('No action needed');
    // A row recorded before Phase 6 carries no source object and reads as a Deal.
    await expect(table.getByRole('row').filter({ hasText: 'Deal #900499' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Retry Bitrix lead #700601' })).toBeVisible();
    const text = await page.getByRole('main').innerText();
    for (const code of ['not_in_manifest', 'outside_manifest_scope', 'needs_review', 'ONCRMLEADADD']) {
      expect(text, code).not.toContain(code);
    }
  });

  test('keyboard: Retry on a lead row is reachable by Tab with a visible focus ring', async ({ page }) => {
    await open(page, 'p6-sync-scope-active');
    const retry = page.getByRole('button', { name: 'Retry Bitrix lead #700601' });
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      if (await retry.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(retry).toBeFocused();
    expect(await retry.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  });
});

test.describe('Lead provenance and role visibility', () => {
  // Direction A Batch 1 (LE-01, LE-02): true pager by Bitrix lead number, owner column,
  // provenance on demand, chips with exact counts, link tabs on the record.
  test('first page of a long list: true pager "1–50 of 160", Next page only', async ({ page }) => {
    await open(page, 'p6-leads-limited');
    const table = page.getByRole('table', { name: '1–50 of 160 leads' });
    await expect(table.getByRole('row')).toHaveCount(51);
    const pager = page.getByRole('navigation', { name: 'Lead pages' });
    await expect(pager).toContainText('1–50 of 160 leads');
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/app/leads?page=2');
    await expect(pager.getByRole('link', { name: 'Previous page' })).toHaveCount(0);
    await expect(page.getByRole('main')).toContainText('Sorted by Bitrix lead number, newest first.');
  });

  test('middle page: Previous and Next; last page: Previous only', async ({ page }) => {
    await open(page, 'p6-leads-page-middle');
    const pager = page.getByRole('navigation', { name: 'Lead pages' });
    await expect(pager.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/app/leads');
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/app/leads?page=3');
    await expect(page.getByRole('table', { name: '51–100 of 160 leads' })).toContainText('BXL-800050');

    await open(page, 'p6-leads-page-last');
    const lastPager = page.getByRole('navigation', { name: 'Lead pages' });
    await expect(lastPager.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/app/leads?page=3');
    await expect(lastPager.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    await expect(page.getByRole('table', { name: '151–160 of 160 leads' })).toBeVisible();
  });

  test('page past the end says so and offers the first page, not the first-time empty state', async ({ page }) => {
    await open(page, 'p6-leads-page-past-end');
    const main = page.getByRole('main');
    await expect(main.getByRole('status')).toContainText('That was the last page');
    await expect(main).not.toContainText('No leads to show');
    await expect(main.getByRole('link', { name: 'Back to first page' })).toHaveAttribute('href', '/app/leads');
    await expect(main.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  });

  test('single-page lists: range shown, no Previous or Next link', async ({ page }) => {
    for (const state of ['p6-leads-sales', 'p6-leads-manager']) {
      await open(page, state);
      const pager = page.getByRole('navigation', { name: 'Lead pages' });
      await expect(pager, state).toContainText('1–2 of 2 leads');
      await expect(pager.getByRole('link'), state).toHaveCount(0);
    }
    await open(page, 'p6-leads-empty');
    await expect(page.getByRole('navigation', { name: 'Lead pages' })).toHaveCount(0);
  });

  test('keyboard: Next page is reachable by Tab after the list with a visible focus ring', async ({ page }) => {
    await open(page, 'p6-leads-page-middle');
    const next = page.getByRole('link', { name: 'Next page' });
    const previous = page.getByRole('link', { name: 'Previous page' });
    // From the last row's Details control, Tab forward to the pager.
    await page.locator('summary', { hasText: 'Details for BXL-800099' }).focus();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      if (await next.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(next).toBeFocused();
    expect(await next.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Shift+Tab');
    await expect(previous).toBeFocused();
  });

  test('390 px: pager links fit and stay at least 44 px tall', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'p6-leads-page-middle');
    await noHorizontalScroll(page);
    for (const name of ['Previous page', 'Next page']) {
      const box = await page.getByRole('link', { name }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width, name).toBeLessThanOrEqual(390);
    }
  });

  test('Sales lead list: owner column, unknown status fallback, provenance in Details, late badge; no contact or amount', async ({ page }) => {
    await open(page, 'p6-leads-sales');
    const table = page.getByRole('table', { name: '1–2 of 2 leads' });
    await expect(table.getByRole('columnheader')).toHaveText(['Customer and trip', 'Status', 'Source', 'Owner', 'Branch', 'Created', 'Details']);
    await expect(table).toContainText('BXL-700601');
    await expect(table).toContainText('Status not recognised (code in details)');
    await expect(table).toContainText('Source not recognised (code in details)');
    await expect(table.locator('[data-slot="status-badge"]', { hasText: 'Not updated from Bitrix for over a day' })).toBeVisible();
    await expect(table).not.toContainText('Why you can see it');
    await table.locator('summary', { hasText: 'Details for BXL-700601' }).click();
    await expect(table.getByText('Bitrix code: NEW. Reading Bitrix names is switched off.')).toBeVisible();
    await expect(table).toContainText('#700601');
    await expect(table).toContainText('You see this lead because you own it.');
    const main = page.getByRole('main');
    // DA-101a: the scope hint stays for screen readers (the box's description).
    await expect(main.getByRole('searchbox', { name: 'Search this page' })).toHaveAccessibleDescription(/Searches this page only\./);
    // DA-94a: Sales cannot change the names switch, so no names-off line (cells and Details explain).
    await expect(main).not.toContainText('Bitrix names are');
    await expect(main.getByRole('navigation', { name: 'Filter leads' })).toContainText('Mine');
    await expect(main).toContainText('Counts include all pages.');
    await expect(main).not.toContainText('₹');
    await expect(main).not.toContainText(/phone|e-?mail|@/i);
    // Read-only list: no button and no text box (Echo M7); row Details are <summary> disclosures,
    // and the only input is "Search this page".
    await expect(main.getByRole('button')).toHaveCount(0);
    await expect(main.getByRole('textbox')).toHaveCount(0);
    await expect(main.getByRole('searchbox')).toHaveCount(1);
  });

  test('lead record: header with Next line and one primary, link tabs, Bitrix details tab keeps the facts', async ({ page }) => {
    await open(page, 'p6-lead-sales');
    const main = page.getByRole('main');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Synthetic enquiry form: Udaipur weekend');
    await expect(main).toContainText('Next: follow up in Bitrix · You');
    await expect(main.getByRole('link', { name: 'New quotation' })).toHaveAttribute('href', '/preview/p6-lead-sales-quotations');
    const tabs = main.getByRole('navigation', { name: 'Lead sections' });
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Quotations', 'Bitrix details']);
    await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(main).toContainText('Created in Bitrix');
    await open(page, 'p6-lead-sales-bitrix');
    const details = page.getByRole('region', { name: 'Bitrix details' });
    await expect(details).toContainText('#700601');
    await expect(details).toContainText('Bitrix code: NEW. Reading Bitrix names is switched off.');
    await expect(details).toContainText('Title, status, source and owner come from Bitrix. Change them in Bitrix.');
    await expect(details).toContainText('It does not prove which form the customer used.');
    await expect(details.getByRole('button')).toHaveCount(0);
  });

  test('stale lead with an unknown status and another owner says so in words', async ({ page }) => {
    await open(page, 'p6-lead-raw-status-stale');
    const main = page.getByRole('main');
    const note = main.getByRole('note');
    await expect(note).toContainText('Not updated from Bitrix for over a day. Check the lead in Bitrix before you rely on it.');
    // Echo M6 / copy L-14: the repair step, as one Next line.
    await expect(note).toContainText('Next: an admin checks the Bitrix connection.');
    await expect(main).toContainText('Status not recognised (code in Details)');
    await expect(main).toContainText('Another staff member');
  });

  test('Quotations tab: exactly one primary action, the real card\'s "Create quotation" (copy §16.3, Echo M1)', async ({ page }) => {
    await open(page, 'p6-lead-sales-quotations');
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: 'New quotation' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Create quotation' })).toBeVisible();
    expect(await main.locator('a.bg-brand-strong, button.bg-brand-strong').count()).toBe(1);
  });

  test('integration admin without quotation access: no Quotations tab and no New quotation', async ({ page }) => {
    await open(page, 'p6-lead-admin-no-quotations');
    const main = page.getByRole('main');
    await expect(main.getByRole('navigation', { name: 'Lead sections' }).getByRole('link')).toHaveText(['Overview', 'Bitrix details']);
    await expect(main.getByRole('link', { name: 'New quotation' })).toHaveCount(0);
  });

  test('manager sees branch leads, the owner by name, and Mine (0) as an exact count', async ({ page }) => {
    await open(page, 'p6-leads-manager');
    const table = page.getByRole('table', { name: '1–2 of 2 leads' });
    await expect(table).toContainText('Synthetic Sales Delhi A');
    await expect(table).toContainText('CRM form');
    await expect(page.getByRole('navigation', { name: 'Filter leads' }).getByRole('link', { name: /Mine \(0\)/ })).toBeVisible();
    await open(page, 'p6-leads-mine-empty');
    await expect(page.getByRole('main').getByRole('status')).toContainText('Nothing matches this filter');
  });

  test('empty list explains when leads appear; failed counts are words, never 0', async ({ page }) => {
    await open(page, 'p6-leads-empty');
    await expect(page.getByRole('main').getByRole('status')).toContainText('after the next Bitrix update');
    await open(page, 'p6-leads-counts-unavailable');
    await expect(page.getByRole('navigation', { name: 'Filter leads' })).toContainText('(count unavailable)');
    await expect(page.getByRole('navigation', { name: 'Lead pages' })).toContainText('total not known');
  });

  test('Purchase never sees leads, the import list or sync details', async ({ page }) => {
    await open(page, 'p6-leads-purchase-denied');
    const main = page.getByRole('main');
    await expect(main).toContainText('Leads are not part of your role. Sales handles leads in Bitrix.');
    await expect(main).not.toContainText(/BXL-|lead #|WEBFORM|CRM form|₹/);
    await expect(main.getByRole('table')).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);

    await open(page, 'p6-sync-purchase-denied');
    await expect(page.getByRole('main')).toContainText('Only staff who manage the Bitrix connection, and who hold no Purchase role, can open this page.');
    await expect(scopePanel(page)).toHaveCount(0);
    await expect(page.getByRole('main')).not.toContainText(/import list|synthetic-portal/);
  });

  test('admin sees Bitrix connection as the current page; Sales has no Bitrix connection menu item', async ({ page }) => {
    await open(page, 'p6-sync-scope-active');
    await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Bitrix connection' })).toHaveAttribute('aria-current', 'page');
    await open(page, 'p6-leads-sales');
    await expect(nav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  });
});

test.describe('Lead routes: not-found, Purchase denial, navigation per role, keyboard', () => {
  test('not visible and not found read the same and carry no lead data', async ({ page }) => {
    await open(page, 'p6-lead-not-found');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lead not available');
    const main = page.getByRole('main');
    await expect(main.getByRole('status')).toContainText('does not exist in the CRM, or your role and branch do not let you see it');
    await expect(main).not.toContainText(/BXL-|lead #|WEBFORM|CRM form/);
    await expect(main.getByRole('link', { name: 'Back to leads' })).toHaveAttribute('href', '/app/leads');
    await expect(nav(page).getByRole('link', { name: 'Leads' })).toHaveAttribute('aria-current', 'page');
  });

  test('Purchase opening a lead link gets the no-permission view, no lead data', async ({ page }) => {
    await open(page, 'p6-lead-purchase-denied');
    const main = page.getByRole('main');
    await expect(main).toContainText('Leads are not part of your role. Sales handles leads in Bitrix.');
    await expect(main).not.toContainText(/BXL-|lead #|WEBFORM|CRM form|Synthetic enquiry/);
    await expect(main.getByRole('link')).toHaveCount(0);
  });

  test('Leads link: shown for Sales, Manager and integration admin; never for Purchase', async ({ page }) => {
    for (const state of ['p6-leads-sales', 'p6-leads-manager', 'p6-sync-scope-active']) {
      await open(page, state);
      await expect(nav(page).getByRole('link', { name: 'Leads', exact: true }), state).toHaveAttribute('href', '/app/leads');
    }
    await open(page, 'p6-leads-sales');
    await expect(nav(page).getByRole('link', { name: 'Leads', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav(page).getByRole('link', { name: 'Deals' })).not.toHaveAttribute('aria-current', 'page');
    for (const state of ['p6-leads-purchase-denied', 'p6-lead-purchase-denied', 'p6-sync-purchase-denied']) {
      await open(page, state);
      await expect(nav(page).getByRole('link', { name: 'Leads', exact: true }), state).toHaveCount(0);
      await expect(nav(page).getByRole('link', { name: 'Deals' }), state).toBeVisible();
    }
  });

  test('Leads and Deals are separate menu items in pipeline order', async ({ page }) => {
    await open(page, 'p6-leads-sales');
    const labels = await nav(page).getByRole('link').allInnerTexts();
    expect(labels.slice(0, 3)).toEqual(['Home', 'Leads', 'Deals']);
  });

  test('keyboard: Tab reaches a lead link with a visible focus ring and the lead route', async ({ page }) => {
    await open(page, 'p6-leads-sales');
    // Batch 1: the customer-and-trip title is the link; the BXL reference sits under it.
    const link = page.getByRole('link', { name: 'Synthetic enquiry form: Udaipur weekend' });
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await link.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(link).toBeFocused();
    expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await expect(link).toHaveAttribute('href', '/app/leads/l6000000-0000-4000-8000-000000000001');
  });

  test('keyboard: Back to leads on the detail page is reachable by Tab', async ({ page }) => {
    await open(page, 'p6-lead-sales');
    const back = page.getByRole('link', { name: 'Back to leads' });
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await back.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(back).toBeFocused();
  });

  test('import list that cannot be read says so; never reads as no list or healthy', async ({ page }) => {
    await open(page, 'p6-sync-scope-unavailable');
    const panel = scopePanel(page);
    await expect(panel).toContainText('Could not be read');
    await expect(panel.getByRole('note')).toContainText('Next:');
    await expect(panel).not.toContainText(/No approved import list|All \d+ imported/);
    await expect(panel.getByRole('progressbar')).toHaveCount(0);
    // The inbox may still hold Leads, so page-level problems say "record", not "deal".
    await expect(page.getByRole('region', { name: 'What needs fixing' })).toContainText('1 record needs a person');
  });

  test('scope_changed row: plain sentence, Admin with owner, never moves records automatically', async ({ page }) => {
    await open(page, 'p6-sync-scope-changed');
    const row = page.getByRole('table', { name: /needs? attention/ }).getByRole('row').filter({ hasText: 'Lead #700607' });
    await expect(row).toContainText('different company or branch than the current Bitrix intake setup');
    await expect(row).toContainText('The CRM record was left as it was.');
    await expect(row).toContainText('· an admin, with the owner');
    await expect(row).toContainText('never moves a record to another company or branch automatically');
    await expect(page.getByRole('main')).not.toContainText('scope_changed');
  });
});
