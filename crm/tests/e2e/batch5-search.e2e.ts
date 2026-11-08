import { expect, type Page, test } from '@playwright/test';
import { enforceProductionStylePolicy, LOCAL_NETWORK_ACCESS_OFF, trackViolations } from '../helpers/production-style-policy';
import { accessibilitySuite, axe, cspSuite, noHorizontalScroll, open } from './b11-helpers';

/**
 * Batch 5 search box on Leads and Deals (contracts.md §E; copy DA-300 to
 * DA-319) through the preview gallery: every state (idle, too short,
 * searching, results with Show more, no results, not installed, not
 * authorized, error), typed words kept after every refusal, Clear search,
 * Escape, focus after Show more, results that survive a list refresh, the
 * words never in the address, rows identical to the list rows, accessibility
 * at desktop, 375 px and 200 % zoom, and the production style policy while
 * searching. Synthetic pool and stand-in actions only: not evidence of a real
 * journey (the database half is Atlas's batch5-search suite).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'b5-leads-search',
  'b5-leads-search-slow',
  'b5-leads-search-more-fails',
  'b5-leads-search-not-installed',
  'b5-leads-search-not-authorized',
  'b5-leads-search-error',
  'b5-leads-search-filter-empty',
  'b5-leads-search-nothing-visible',
  'b5-leads-page-only',
  'b5-deals-search',
  'b5-deals-search-not-installed',
  'b5-deals-search-error',
  'b5-features-no-permission-purchase',
];

accessibilitySuite('Batch 5 search: accessibility (idle)', STATES);
cspSuite('Batch 5 search: production style policy (idle)', STATES);

async function search(page: Page, list: 'leads' | 'deals', words: string) {
  const box = page.getByRole('searchbox', { name: `Search ${list}` });
  await box.fill(words);
  await box.press('Enter');
  return box;
}

const status = (page: Page) => page.locator('[data-slot="search-announce"]');

test.describe('Leads search box (DA-300 to DA-315)', () => {
  test('idle: label, visible hint, max length, list as today; the Search button is the one primary', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const main = page.locator('main');
    const box = main.getByRole('searchbox', { name: 'Search leads' });
    await expect(box).toHaveAttribute('maxlength', '60');
    await expect(box).toHaveAttribute('placeholder', 'Reference, Bitrix number, customer or trip');
    await expect(box).toHaveAccessibleDescription(
      'Searches all leads you can see, not just this page, by reference, Bitrix number or Customer and trip. Not by phone or e-mail.',
    );
    await expect(main.getByRole('search', { name: 'Search leads' })).toHaveCount(1);
    await expect(main.getByRole('button', { name: 'Search', exact: true })).toHaveCount(1);
    await expect(main.getByRole('button', { name: 'Clear search' })).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'Leads table' }).locator('tbody tr')).toHaveCount(8);
    await expect(main.getByRole('heading', { name: 'Search results' })).toHaveCount(0);
  });

  test('too short: message tied to the box, words kept, nothing posted, list stays', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url());
    });
    const box = await search(page, 'leads', ' a ');
    await expect(page.locator('main')).toContainText('Type at least 2 characters to search.');
    await expect(box).toHaveAttribute('aria-invalid', 'true');
    await expect(box).toHaveAccessibleDescription(/Type at least 2 characters to search\./);
    await expect(box).toHaveValue(' a ');
    await expect(box).toBeFocused();
    await expect(status(page)).toHaveText('Type at least 2 characters to search.');
    await expect(page.getByRole('region', { name: 'Leads table' })).toBeVisible();
    expect(posts).toEqual([]);
    // Typing enough characters lifts the message.
    await box.fill('goa');
    await expect(page.locator('main')).not.toContainText('Type at least 2 characters to search.');
  });

  test('results: same rows as the list, count without a total, filters note, words never in the address', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const url = page.url();
    const listRow = await page.getByRole('region', { name: 'Leads table' }).locator('tbody tr').first().innerHTML();
    const posts: Array<{ url: string; body: string }> = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postData() ?? '' });
    });
    const box = await search(page, 'leads', 'goa');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: 'Search results', level: 2 })).toBeVisible();
    const results = main.getByRole('region', { name: 'Lead search results' });
    await expect(results.locator('tbody tr')).toHaveCount(20);
    await expect(results.locator('caption')).toHaveText('Leads matching “goa”');
    await expect(main.locator('[data-slot="search-count"]')).toHaveText('Showing 20 matches for “goa”. More are available.');
    await expect(status(page)).toHaveText('Showing 20 matches for “goa”. More are available.');
    // DA-308: with All chosen, only the first sentence; the chips step aside while results show (Echo-B L4, L5).
    await expect(main.locator('[data-slot="search-filters-note"]')).toHaveText('Filters do not apply to search results.');
    await expect(main.getByRole('navigation', { name: 'Filter leads' })).toHaveCount(0);
    await expect(main).not.toContainText(/of \d+ (leads|matches)/);
    // The list is replaced by the results; the first found row is the same lead with the same markup.
    await expect(main.getByRole('region', { name: 'Leads table' })).toHaveCount(0);
    // Server-rendered text joins carry empty comment markers; the markup is otherwise identical.
    const bare = (html: string) => html.replace(/<!--.*?-->/g, '');
    expect(bare(await results.locator('tbody tr').first().innerHTML())).toBe(bare(listRow));
    await expect(box).toHaveValue('goa');
    expect(page.url()).toBe(url);
    expect(page.url()).not.toContain('goa');
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p.url).not.toContain('goa');
    expect(posts.some((p) => p.body.includes('goa'))).toBe(true);
  });

  test('Show more appends, focuses the first new row, then disappears on the last page', async ({ page }) => {
    await open(page, 'b5-leads-search');
    await search(page, 'leads', 'goa');
    const results = page.getByRole('region', { name: 'Lead search results' });
    await expect(results.locator('tbody tr')).toHaveCount(20);
    await page.getByRole('button', { name: 'Show more leads' }).click();
    await expect(results.locator('tbody tr')).toHaveCount(22);
    await expect(results.locator('[data-slot="row-link"]').nth(20)).toBeFocused();
    await expect(page.locator('[data-slot="search-count"]')).toHaveText('22 matches for “goa”.');
    await expect(status(page)).toHaveText('22 matches for “goa”.');
    await expect(page.getByRole('button', { name: 'Show more leads' })).toHaveCount(0);
  });

  test('a list refresh keeps the results and the typed words', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const box = await search(page, 'leads', 'goa');
    await expect(page.getByRole('region', { name: 'Lead search results' }).locator('tbody tr')).toHaveCount(20);
    const refreshed = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/preview/b5-leads-search'));
    await page.getByRole('button', { name: 'Refresh the list (preview)' }).click();
    await refreshed;
    await expect(page.getByRole('region', { name: 'Lead search results' }).locator('tbody tr')).toHaveCount(20);
    await expect(box).toHaveValue('goa');
  });

  test('Clear search and Escape return to the list with focus in the box', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const box = await search(page, 'leads', 'goa');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('region', { name: 'Leads table' }).locator('tbody tr')).toHaveCount(8);
    await expect(page.getByRole('heading', { name: 'Search results' })).toHaveCount(0);
    await expect(box).toHaveValue('');
    await expect(box).toBeFocused();
    await expect(status(page)).toHaveText('Search cleared. The list is shown again.');
    await search(page, 'leads', 'kerala');
    await expect(page.getByRole('region', { name: 'Lead search results' })).toBeVisible();
    await box.press('Escape');
    await expect(page.getByRole('region', { name: 'Leads table' })).toBeVisible();
    await expect(box).toHaveValue('');
  });

  test('emptying the box (the browser × or deleting every character) is Clear search', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const box = await search(page, 'leads', 'goa');
    await expect(page.getByRole('region', { name: 'Lead search results' })).toBeVisible();
    // The native × fires an input event with an empty value, as fill('') does.
    await box.fill('');
    await expect(page.getByRole('region', { name: 'Leads table' }).locator('tbody tr')).toHaveCount(8);
    await expect(page.getByRole('heading', { name: 'Search results' })).toHaveCount(0);
    await expect(status(page)).toHaveText('Search cleared. The list is shown again.');
    await expect(page.getByRole('navigation', { name: 'Filter leads' })).toBeVisible();
  });

  test('numbers search references only, at any length', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const main = page.locator('main');
    await search(page, 'leads', '9100');
    await expect(main.locator('[data-slot="search-count"]')).toHaveText('1 match for “9100”.');
    await expect(main).toContainText('Numbers search references and Bitrix numbers only.');
    await search(page, 'leads', '12345');
    await expect(main.getByRole('heading', { name: 'No lead you can see has a reference or Bitrix number starting with “12345”.' })).toBeVisible();
    await expect(main).toContainText('Numbers search references and Bitrix numbers only. Check the reference, or find the lead in Bitrix.');
  });

  test('no results (3+ characters and 2 characters) and the two-character note', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const main = page.locator('main');
    await search(page, 'leads', 'zzz');
    await expect(main.getByRole('heading', { name: 'No lead you can see matches “zzz”.', level: 3 })).toBeVisible();
    await expect(main).toContainText('Search checks the reference, Bitrix number and Customer and trip only. Check the spelling, or find the lead in Bitrix.');
    await expect(main).toContainText('Filters do not apply to search results.');
    await expect(status(page)).toContainText('No lead you can see matches “zzz”.');
    await search(page, 'leads', 'zz');
    await expect(main.getByRole('heading', { name: 'No lead you can see has a reference or Bitrix number starting with “zz”.' })).toBeVisible();
    await expect(main).toContainText('Type 3 or more characters to also search Customer and trip, or find the lead in Bitrix.');
    await expect(main).not.toContainText('Two characters search references');
    await search(page, 'leads', '91');
    await expect(main.locator('[data-slot="search-count"]')).toHaveText('1 match for “91”.');
    await expect(main).toContainText('Two characters search references and Bitrix numbers only. Type 3 or more to also search Customer and trip.');
  });

  test('searching: the button and the status say so while the answer loads', async ({ page }) => {
    await open(page, 'b5-leads-search-slow');
    // Every POST from here on: the one search, and nothing for the presses made while it runs.
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url());
    });
    const box = await search(page, 'leads', 'goa');
    await expect(page.locator('[data-slot="search-submit"]')).toHaveText('Searching…');
    await expect(page.locator('[data-slot="search-submit"]')).toHaveAttribute('aria-busy', 'true');
    await expect(status(page)).toHaveText('Searching leads…');
    await expect(box).toHaveValue('goa');
    // Presses while searching are ignored (Echo-B L2): one search only.
    await box.press('Enter');
    // force: Playwright would otherwise wait for the aria-disabled button to become usable, then press it after the search.
    await page.locator('[data-slot="search-submit"]').click({ force: true });
    await expect(page.locator('[data-slot="search-submit"]')).toHaveText('Searching…');
    await expect(page.getByRole('region', { name: 'Lead search results' }).locator('tbody tr')).toHaveCount(20, { timeout: 10_000 });
    await expect(page.locator('[data-slot="search-submit"]')).toHaveText('Search');
    expect(posts).toHaveLength(1);
  });

  test('Show more fails: the matches stay, the button stays, the failure is said', async ({ page }) => {
    await open(page, 'b5-leads-search-more-fails');
    await search(page, 'leads', 'goa');
    const more = page.getByRole('button', { name: 'Show more leads' });
    await more.click();
    await expect(page.locator('main')).toContainText('More matches could not be loaded. The matches above are unchanged. Try Show more leads again.');
    await expect(status(page)).toHaveText('More matches could not be loaded. The matches above are unchanged. Try Show more leads again.');
    await expect(page.getByRole('region', { name: 'Lead search results' }).locator('tbody tr')).toHaveCount(20);
    await expect(more).toBeVisible();
  });

  test('not installed: honest notice, then page-only search with the words kept and applied', async ({ page }) => {
    await open(page, 'b5-leads-search-not-installed');
    await search(page, 'leads', 'goa');
    const main = page.locator('main');
    await expect(main).toContainText('Searching all leads is not installed in this CRM yet. This box searches this page only.');
    const box = main.getByRole('searchbox', { name: 'Search this page' });
    await expect(box).toHaveValue('goa');
    await expect(box).toHaveAttribute('placeholder', 'Name, trip or reference');
    await expect(main).toContainText('4 of 8 leads on this page match.');
    await expect(main.getByRole('region', { name: 'Leads table' }).locator('tbody tr:visible')).toHaveCount(4);
    await expect(main.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
    await box.fill('nothing like it');
    await expect(main).toContainText('No match on this page. Try Next page, or find the lead in Bitrix.');
    await main.getByRole('button', { name: 'Clear search' }).click();
    await expect(main.getByRole('region', { name: 'Leads table' }).locator('tbody tr:visible')).toHaveCount(8);
  });

  test('not authorized and error: the reason in words, words kept, list stays', async ({ page }) => {
    for (const [state, words] of [
      ['b5-leads-search-not-authorized', 'Not searched: your access does not include the leads list. If you need it, ask your admin.'],
      ['b5-leads-search-error', 'Search did not finish. Nothing was changed. Your words are still in the box, so you can try again.'],
    ] as const) {
      await open(page, state);
      const box = await search(page, 'leads', 'goa');
      const main = page.locator('main');
      await expect(main.locator('[data-slot="notice"]'), state).toContainText(words);
      await expect(main.locator('[data-slot="notice"] svg'), state).toHaveCount(1);
      await expect(status(page), state).toHaveText(words);
      await expect(box, state).toHaveValue('goa');
      await expect(main.getByRole('region', { name: 'Leads table' }), state).toBeVisible();
      await expect(main.getByRole('button', { name: 'Clear search' }), state).toBeVisible();
    }
  });

  test('an empty filter still offers search; nothing visible at all shows no box; no action keeps "Search this page"', async ({ page }) => {
    await open(page, 'b5-leads-search-filter-empty');
    await search(page, 'leads', 'kerala');
    await expect(page.getByRole('region', { name: 'Lead search results' }).locator('tbody tr')).not.toHaveCount(0);
    // DA-308 second sentence only because "Mine" is chosen; the chips come back after Clear search.
    await expect(page.locator('[data-slot="search-filters-note"]')).toHaveText('Filters do not apply to search results. Your filter comes back when you clear search.');
    await expect(page.getByRole('navigation', { name: 'Filter leads' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('navigation', { name: 'Filter leads' }).getByRole('link', { name: /^Mine/ })).toHaveAttribute('aria-current', 'page');
    await open(page, 'b5-leads-search-nothing-visible');
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await open(page, 'b5-leads-page-only');
    await expect(page.getByRole('searchbox', { name: 'Search this page' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
  });
});

test('N1: Features refused for a Bitrix-connection manager who also works in Purchase', async ({ page }) => {
  await open(page, 'b5-features-no-permission-purchase');
  await expect(page.locator('main').getByRole('status')).toHaveText(
    'Features is not available to staff who also work in Purchase. Ask a Super Admin to change these switches.',
  );
  await open(page, 'admin-workflow-no-permission');
  await expect(page.locator('main').getByRole('status')).toHaveText('Only a Super Admin or staff who manage the Bitrix connection can open Features.');
});

test.describe('Deals search box', () => {
  test('results use the Deals rows without services; the order control steps aside and comes back', async ({ page }) => {
    await open(page, 'b5-deals-search');
    const main = page.locator('main');
    const order = main.getByRole('group', { name: 'Order of deals' });
    await expect(order).toBeVisible();
    await expect(main.getByRole('searchbox', { name: 'Search deals' })).toHaveAccessibleDescription(/Searches all deals you can see/);
    await search(page, 'deals', 'goa');
    const results = main.getByRole('region', { name: 'Deal search results' });
    await expect(results.locator('tbody tr')).toHaveCount(20);
    await expect(results.getByRole('columnheader')).toHaveText(['Reference', 'Customer and trip', 'Stage', 'Owner', 'Details']);
    await expect(main).toContainText('Services and progress are not shown in search results. Open the deal to see them.');
    await expect(order).toHaveCount(0);
    await main.getByRole('button', { name: 'Show more deals' }).click();
    await expect(results.locator('tbody tr')).toHaveCount(22);
    await main.getByRole('button', { name: 'Clear search' }).click();
    await expect(main.getByRole('group', { name: 'Order of deals' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'Deals table' })).toBeVisible();
  });

  test('not installed and error on Deals', async ({ page }) => {
    await open(page, 'b5-deals-search-not-installed');
    await search(page, 'deals', 'goa');
    await expect(page.locator('main')).toContainText('Searching all deals is not installed in this CRM yet. This box searches this page only.');
    await expect(page.getByRole('searchbox', { name: 'Search this page' })).toHaveValue('goa');
    await open(page, 'b5-deals-search-error');
    const box = await search(page, 'deals', 'goa');
    await expect(page.locator('main')).toContainText('Search did not finish. Nothing was changed.');
    await expect(box).toHaveValue('goa');
  });
});

test.describe('Search states: accessibility after interaction', () => {
  const CASES: Array<{ state: string; list: 'leads' | 'deals'; words: string; name: string }> = [
    { state: 'b5-leads-search', list: 'leads', words: 'goa', name: 'results' },
    { state: 'b5-leads-search', list: 'leads', words: 'zzz', name: 'no results' },
    { state: 'b5-leads-search', list: 'leads', words: 'a', name: 'too short' },
    { state: 'b5-leads-search-not-installed', list: 'leads', words: 'goa', name: 'not installed' },
    { state: 'b5-leads-search-not-authorized', list: 'leads', words: 'goa', name: 'not authorized' },
    { state: 'b5-leads-search-error', list: 'leads', words: 'goa', name: 'error' },
    { state: 'b5-deals-search', list: 'deals', words: 'goa', name: 'deal results' },
  ];
  for (const c of CASES) {
    test(`axe clean at 1440 and 375, one h1, no sideways scroll at 375 and 200% zoom: ${c.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      for (const size of [
        { width: 1440, height: 900 },
        { width: 375, height: 812 },
        { width: 640, height: 400 },
      ]) {
        await page.setViewportSize(size);
        await open(page, c.state);
        await search(page, c.list, c.words);
        await expect(page.locator('[data-slot="search-announce"]')).not.toHaveText('');
        await expect(page.locator('[data-slot="search-announce"]')).not.toHaveText(/^Searching (leads|deals)…$/);
        expect(await page.getByRole('heading', { level: 1 }).count(), `${c.name}: h1`).toBe(1);
        if (size.width < 1440) await noHorizontalScroll(page, `${c.name} at ${size.width}`);
        if (size.width !== 640) expect(await axe(page), `${c.name} at ${size.width}`).toEqual([]);
      }
    });
  }

  test('keyboard: Tab reaches the box, Search and Clear search with a visible focus ring', async ({ page }) => {
    await open(page, 'b5-leads-search');
    const box = page.getByRole('searchbox', { name: 'Search leads' });
    await box.focus();
    await box.fill('goa');
    await page.keyboard.press('Tab');
    const submit = page.getByRole('button', { name: 'Search', exact: true });
    await expect(submit).toBeFocused();
    const ring = await submit.evaluate((el) => getComputedStyle(el).boxShadow + getComputedStyle(el).outlineStyle);
    expect(ring).not.toBe('nonenone');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Lead search results' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeFocused();
  });
});

test.describe('Search under the production style policy', () => {
  test('searching, Show more, refusals and clearing add no style violations', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    const applied: string[] = [];
    await enforceProductionStylePolicy(context, applied, (url) => url.pathname.startsWith('/preview/b5-'));
    const { violations } = await trackViolations(context);
    const page = await context.newPage();
    await open(page, 'b5-leads-search');
    await search(page, 'leads', 'goa');
    await page.getByRole('button', { name: 'Show more leads' }).click();
    await expect(page.getByRole('region', { name: 'Lead search results' }).locator('tbody tr')).toHaveCount(22);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await search(page, 'leads', 'a');
    await open(page, 'b5-leads-search-not-installed');
    await search(page, 'leads', 'goa');
    await expect(page.locator('main')).toContainText('4 of 8 leads on this page match.');
    await open(page, 'b5-deals-search');
    await search(page, 'deals', 'goa');
    await expect(page.getByRole('region', { name: 'Deal search results' })).toBeVisible();
    expect(await page.locator('main [style]').count()).toBe(0);
    expect(applied.length).toBeGreaterThanOrEqual(3);
    expect(violations).toEqual([]);
    await context.close();
  });
});
