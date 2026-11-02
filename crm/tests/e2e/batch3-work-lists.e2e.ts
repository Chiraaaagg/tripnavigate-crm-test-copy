import { expect, test, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { axe, cspSuite, noHorizontalScroll, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * Direction A Batch 3 through the design preview states (synthetic view
 * models, stand-in actions): Quotations and Itineraries lists, the New
 * quotation / New itinerary choice, the referral draft page and its tabs,
 * linking (no preselection, confirmation), link removal, closed drafts with
 * Reopen, the Deal section, the referral quotation editor and the Home rows.
 * Visual and interaction evidence only; the real journey is
 * b3-referral.real.e2e.ts on a local real stack.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'b3-quotations-list',
  'b3-quotations-manager-all',
  'b3-quotations-ready-to-book',
  'b3-quotations-closed-drafts',
  'b3-quotations-reference-hit',
  'b3-quotations-reference-miss',
  'b3-quotations-page-2',
  'b3-quotations-more',
  'b3-quotations-empty',
  'b3-quotations-error',
  'b3-quotations-not-installed',
  'b3-quotations-not-applicable',
  'b3-quotations-loading',
  'b3-itineraries-list',
  'b3-itineraries-empty',
  'b3-new-quotation-on',
  'b3-new-quotation-branches',
  'b3-new-quotation-off',
  'b3-new-quotation-unknown',
  'b3-new-itinerary-on',
  'b3-new-quotation-not-allowed',
  'b3-draft-overview',
  'b3-draft-quotations',
  'b3-draft-itineraries',
  'b3-draft-link',
  'b3-draft-link-empty',
  'b3-draft-link-lead',
  'b3-draft-linked',
  'b3-draft-history',
  'b3-draft-link-load-error',
  'b3-draft-link-locked',
  'b3-draft-ready-to-book',
  'b3-draft-manager',
  'b3-draft-closed',
  'b3-draft-closed-duplicate',
  'b3-draft-closed-quotations',
  'b3-draft-closed-linked',
  'b3-draft-not-available',
  'b3-draft-load-error',
  'b3-deal-referral-drafts',
  'b3-quote-referral-accepted-unlinked',
  'b3-quote-referral-accepted-linked',
  'b3-quote-referral-closed',
  'b3-itin-referral',
  'b3-home-sales',
  'b3-home-manager',
];

/** Money words never appear on a list, the choice screen, a draft page or the Deal section (lead ruling: no money in lists). */
const MONEY = [/₹/, /Final price/i, /Selling/i, /Margin/i, /Net rate/i];
// The editors (quotation, itinerary) keep their own money rules (b12 suites); lists, choice, draft pages and the Deal section carry none.
const NO_MONEY_STATES = STATES.filter((s) => !s.startsWith('b3-quote-') && !s.startsWith('b3-itin-') && !s.startsWith('b3-home-'));

test.describe('Batch 3: accessibility at 1440, 375 and 200 % zoom', () => {
  for (const state of STATES) {
    test(`axe clean; one h1; no sideways scroll at 375 and 640 × 400: ${state}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await axe(page), state).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count(), `${state}: h1 count`).toBe(1);
      await pillsHaveIconAndWord(page);
      await page.setViewportSize({ width: 375, height: 812 });
      await open(page, state);
      await noHorizontalScroll(page, state);
      expect(await axe(page), `${state} at 375`).toEqual([]);
      await page.setViewportSize({ width: 640, height: 400 });
      await open(page, state);
      await noHorizontalScroll(page, `${state} at 200 %`);
    });
  }
});

cspSuite('Batch 3: production style policy', STATES);

/** Primary buttons and primary-styled links inside main (one per screen). The current filter chip shares the colour but is not an action (aria-current). */
async function primaries(page: Page): Promise<number> {
  return page.locator('main').locator('a.bg-brand-strong:visible:not([aria-current]), button.bg-brand-strong:visible').count();
}

test.describe('Batch 3: one primary action per screen', () => {
  for (const state of STATES.filter((s) => !s.startsWith('b3-quote-') && !s.startsWith('b3-itin-') && s !== 'b3-quotations-loading')) {
    test(`at most one primary: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, state);
      expect(await primaries(page), state).toBeLessThanOrEqual(1);
    });
  }
});

test.describe('Batch 3: lists (QL, IL)', () => {
  test('Quotations: scope named, chips with counts, Mine / All switch, search this page, open by reference, keyset pager, no money', async ({ page }) => {
    await open(page, 'b3-quotations-list');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Quotations' })).toBeVisible();
    await expect(main.locator('header')).toContainText('Quotations you made or own');
    await expect(main.getByRole('link', { name: 'New quotation' })).toHaveAttribute('href', '/app/quotations/new');
    const chips = main.getByRole('navigation', { name: 'Filter quotations' });
    await expect(chips.getByRole('link', { name: /Open \(5\)/ })).toHaveAttribute('aria-current', 'page');
    await expect(chips.getByRole('link', { name: /Accepted, not linked \(1\)/ })).toHaveAttribute('href', '/app/quotations?filter=accepted_not_linked');
    await expect(main).toContainText('Counts include all pages.');
    const scope = main.getByRole('group', { name: 'Which quotations to show' });
    await expect(scope.locator('[aria-current="true"]')).toHaveText('Mine');
    await expect(scope.getByRole('link', { name: 'All you can open' })).toHaveAttribute('href', '/app/quotations?scope=all');
    await expect(main).toContainText('Closed drafts that were never linked are not in this list. Choose “Closed drafts” or open one by its reference.');
    // DA-209: the owner is labelled; an empty validity says when it is set.
    await expect(main.locator('#quotations-table')).toContainText('TQ-7001 · version 2 · Owner: you');
    await expect(main.locator('#quotations-table')).toContainText('Owner: Synthetic Sales Jodhpur B');
    await expect(main.locator('#quotations-table')).toContainText('Set when shared');
    // Rows: status word with icon, subject link (never an "undefined" address), one action each.
    const rows = main.locator('#quotations-table tbody tr');
    await expect(rows).toHaveCount(5);
    for (const href of await main.locator('#quotations-table a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) expect(href).not.toContain('undefined');
    await expect(rows.nth(3).getByRole('link', { name: /^Link to deal/ })).toHaveAttribute('href', /\/app\/quotations\/drafts\/.+\?tab=link$/);
    await expect(rows.nth(2)).toContainText('Referral draft TD-301 · not linked to Bitrix yet');
    for (const word of MONEY) await expect(main).not.toContainText(word);
    // Search this page hides rendered rows only.
    const search = main.getByLabel('Search this page');
    await search.fill('kerala');
    await expect(rows.filter({ visible: true })).toHaveCount(1);
    await expect(main).toContainText('1 of 5 quotations on this page match.');
    await search.fill('zzzz');
    await expect(main).toContainText('No match on this page. Try Next page, another filter, or open a quotation by its reference.');
    // Open by reference is a plain GET form to the list.
    const form = main.getByRole('search', { name: 'Open by reference' });
    await expect(form).toHaveAttribute('action', '/app/quotations');
    await expect(form.getByLabel('Open by reference')).toHaveAttribute('name', 'reference');
    // Single page: range only, no pager links.
    const pager = main.getByRole('navigation', { name: 'Quotations pages' });
    await expect(pager).toContainText('Showing 5 of 5 quotations');
    // F21: the reference box names both kinds of reference.
    await expect(form.getByRole('textbox')).toHaveAttribute('placeholder', 'TQ-12 or TD-301');
    await expect(pager.getByRole('link')).toHaveCount(0);
  });

  test('Ready to book: the chip lists accepted quotations with a deal; a linked referral row says so and offers Start booking', async ({ page }) => {
    await open(page, 'b3-quotations-ready-to-book');
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: /Ready to book \(2\)/ })).toHaveAttribute('aria-current', 'page');
    const row = main.locator('#quotations-table tbody tr').filter({ hasText: 'TQ-7010' });
    await expect(row).toContainText('Referral draft TD-306 · linked to deal D-5120');
    await expect(row).not.toContainText('not linked to Bitrix yet');
    await expect(row.getByRole('link', { name: /^Start booking/ })).toBeVisible();
  });

  test('keyset pager: "Next page" while more exist, "First page" after; never page numbers', async ({ page }) => {
    await open(page, 'b3-quotations-more');
    const pager = page.getByRole('navigation', { name: 'Quotations pages' });
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/app/quotations?after=synthetic');
    await expect(pager.getByRole('link', { name: 'First page' })).toHaveCount(0);
    await open(page, 'b3-quotations-page-2');
    await expect(pager.getByRole('link', { name: 'First page' })).toHaveAttribute('href', '/app/quotations');
    await expect(pager.getByRole('link', { name: 'Next page' })).toHaveCount(0);
    await expect(pager.getByRole('link', { name: /^\d+$/ })).toHaveCount(0);
  });

  test('closed drafts: the chip shows them read-only with Reopen; reference hit and miss', async ({ page }) => {
    await open(page, 'b3-quotations-closed-drafts');
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: /Closed drafts \(1\)/ })).toHaveAttribute('aria-current', 'page');
    await expect(main.locator('#quotations-table')).toContainText('Closed after 90 days without activity');
    await expect(main.getByRole('link', { name: /^Reopen draft/ })).toBeVisible();
    await open(page, 'b3-quotations-reference-hit');
    await expect(main.getByRole('status').filter({ hasText: 'Showing the result for TD-298.' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Back to the list' })).toHaveAttribute('href', '/app/quotations');
    await open(page, 'b3-quotations-reference-miss');
    const input = main.getByRole('textbox', { name: 'Open by reference' });
    await expect(input).toHaveValue('TD-999');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(main).toContainText('Nothing with that reference that you can open. Check the reference (for example TQ-12 or TD-301).');
  });

  test('error, not installed and not-for-your-role are never an empty list', async ({ page }) => {
    await open(page, 'b3-quotations-error');
    await expect(page.locator('main')).toContainText('Quotations did not load');
    await expect(page.locator('main')).not.toContainText('No quotations yet');
    await expect(page.locator('main table')).toHaveCount(0);
    await open(page, 'b3-quotations-not-installed');
    await expect(page.locator('main')).toContainText('Quotations list not installed');
    await expect(page.locator('main')).toContainText('Open quotations from their lead or deal.');
    await open(page, 'b3-quotations-not-applicable');
    await expect(page.locator('main')).toContainText('No quotations for your role');
    await expect(page.locator('main').getByRole('link', { name: 'New quotation' })).toHaveCount(0);
    // Purchase menu has no Quotations or Itineraries item.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Quotations' })).toHaveCount(0);
  });

  test('Itineraries: basis, status words, open differences, final PDF link; no money', async ({ page }) => {
    await open(page, 'b3-itineraries-list');
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: 'New itinerary' })).toHaveAttribute('href', '/app/itineraries/new');
    const table = main.locator('#itineraries-table');
    await expect(table).toContainText('Not from a quotation');
    await expect(table).toContainText('2 to settle');
    await expect(table).toContainText('From TQ-7001 v2 · Owner: you');
    await expect(table).toContainText('Owner: Synthetic Sales Jodhpur B');
    await expect(table.getByRole('link', { name: /Final PDF/ })).toHaveCount(1);
    await expect(table).not.toContainText('IT-');
    for (const word of MONEY) await expect(main).not.toContainText(word);
    // The menu marks Itineraries as the current page.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itineraries' })).toHaveAttribute('aria-current', 'page');
  });

  for (const state of NO_MONEY_STATES) {
    test(`no money words: ${state}`, async ({ page }) => {
      await open(page, state);
      for (const word of MONEY) await expect(page.locator('main')).not.toContainText(word);
    });
  }
});

test.describe('Batch 3: New quotation / New itinerary (QN, IN)', () => {
  test('for a lead or deal: links to the lists, no picker', async ({ page }) => {
    await open(page, 'b3-new-quotation-on');
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: 'Open Leads' })).toHaveAttribute('href', '/app/leads');
    await expect(main.getByRole('link', { name: 'Open Deals' })).toHaveAttribute('href', '/app/deals');
    await expect(main.getByRole('combobox', { name: /lead|deal/i })).toHaveCount(0);
  });

  test('switch On: a refusal names the fields and keeps every typed value; a possible duplicate never blocks', async ({ page }) => {
    await open(page, 'b3-new-quotation-on');
    const form = page.getByRole('form', { name: 'New referral quotation' });
    await expect(form).toContainText('Only the name is required.');
    // One branch: no Branch field.
    await expect(form.getByLabel('Branch')).toHaveCount(0);
    // DA-213: the title is optional and the hint names what an empty title prints.
    await expect(form.getByLabel('Title (optional)')).toHaveAttribute('aria-describedby', /hint/);
    await expect(form).toContainText('Left empty, it reads “Trip for {customer name}”.');
    await form.getByLabel(/^Mobile/).fill('9876500001');
    await form.getByLabel(/^How did they reach us/).selectOption('walk_in');
    await form.getByRole('button', { name: 'Create referral quotation' }).click();
    const alert = form.getByRole('alert');
    await expect(alert).toContainText('What you typed is still here.');
    await expect(alert.getByRole('link', { name: /Customer name/ })).toHaveAttribute('href', '#referral-quotations-customer');
    await expect(form.getByLabel('Customer name')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByLabel(/^Mobile/)).toHaveValue('9876500001');
    await expect(form.getByLabel(/^How did they reach us/)).toHaveValue('walk_in');
    await expect(form.getByLabel('Title (optional)')).not.toHaveAttribute('aria-invalid', 'true');
    await form.getByLabel('Customer name').fill('Sample Customer Rao');
    await form.getByRole('button', { name: 'Create referral quotation' }).click();
    const created = page.locator('[data-slot="referral-created"]');
    await expect(created).toContainText('Referral draft TD-302 created with its first quotation. Nothing is sent and nothing is in Bitrix.');
    await expect(created).toContainText('This mobile number is already on TD-301. Open one of those, or carry on with the new draft.');
    await expect(created.getByRole('link', { name: 'TD-301' })).toHaveAttribute('href', /\/app\/quotations\/drafts\//);
    await expect(created.getByRole('link', { name: 'Open the new quotation' })).toBeVisible();
  });

  test('several branches: the Branch field appears and is required by the server', async ({ page }) => {
    await open(page, 'b3-new-quotation-branches');
    await expect(page.getByRole('form', { name: 'New referral quotation' }).getByLabel('Branch')).toBeVisible();
  });

  test('switched off between load and submit: the refusal says so and keeps the typed values', async ({ page }) => {
    await open(page, 'b3-new-quotation-switched-off-after-load');
    const form = page.getByRole('form', { name: 'New referral quotation' });
    await form.getByLabel('Customer name').fill('Sample Customer Bose');
    await form.getByLabel('Title (optional)').fill('Andaman week');
    await form.getByRole('button', { name: 'Create referral quotation' }).click();
    await expect(form.getByRole('alert')).toContainText('Referral drafts are switched off, so no new draft was made. Existing drafts keep working.');
    await expect(form.getByLabel('Customer name')).toHaveValue('Sample Customer Bose');
  });

  test('switch Off: no referral form, DA-78 line; Unknown: "could not check", never Off', async ({ page }) => {
    await open(page, 'b3-new-quotation-off');
    const main = page.locator('main');
    await expect(main.getByRole('form', { name: 'New referral quotation' })).toHaveCount(0);
    await expect(main).toContainText('Referral drafts are switched off, so you cannot start a new one. Existing drafts keep working.');
    await open(page, 'b3-new-quotation-unknown');
    await expect(main.getByRole('form', { name: 'New referral quotation' })).toHaveCount(0);
    await expect(main).toContainText('could not check');
    await expect(main).not.toContainText('switched off');
  });

  test('New itinerary: "For a quotation or deal" and the referral itinerary form', async ({ page }) => {
    await open(page, 'b3-new-itinerary-on');
    await expect(page.locator('main')).toContainText('For a quotation or deal');
    await expect(page.getByRole('form', { name: 'New referral itinerary' }).getByRole('button', { name: 'Create referral itinerary' })).toBeVisible();
    await expect(page.locator('main')).toContainText('press “Make branded itinerary” there');
  });

  test('not for this role: no form, the not-for-role words (Echo-B L4)', async ({ page }) => {
    await open(page, 'b3-new-quotation-not-allowed');
    await expect(page.locator('main')).toContainText('No quotations for your role');
    await expect(page.getByRole('form', { name: 'New referral quotation' })).toHaveCount(0);
  });
});

test.describe('Batch 3: referral draft page', () => {
  test('header: status word, reference line, owner, branch, Next and the automatic-close date; tabs as links; one primary', async ({ page }) => {
    await open(page, 'b3-draft-overview');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Sample Customer Mehra · referral draft');
    await expect(main.locator('header')).toContainText('Referral draft TD-301 · not linked to Bitrix yet');
    await expect(main.locator('[data-slot="draft-auto-close"]')).toContainText('Closes on 13 Jan 2027 if nothing changes.');
    await expect(main.locator('[data-slot="draft-next"]')).toContainText('Next: link this draft');
    const tabs = main.getByRole('navigation', { name: 'Referral draft sections' });
    await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Quotations', 'Itineraries', 'Link to Bitrix', 'History']);
    await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(main.getByRole('link', { name: 'Link to Bitrix' }).first()).toHaveAttribute('href', /\?tab=link$/);
    await expect(main).toContainText('Only the owner and the branch Manager can open this draft.');
    expect(await primaries(page)).toBe(1);
    // Navigation: Quotations is the current menu item.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Quotations' })).toHaveAttribute('aria-current', 'page');
  });

  test('Close draft: reason required (typed note kept), then closed', async ({ page }) => {
    await open(page, 'b3-draft-overview');
    await page.getByRole('button', { name: 'Close draft' }).click();
    const dialog = page.getByRole('dialog', { name: 'Close this draft?' });
    await dialog.getByLabel(/^Note/).fill('Customer went quiet');
    await dialog.getByRole('button', { name: 'Close draft' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel(/^Note/)).toHaveValue('Customer went quiet');
    await dialog.getByLabel('Customer not going ahead').check();
    await dialog.getByRole('button', { name: 'Close draft' }).click();
    await expect(dialog).toBeHidden();
    // After the refresh the page is the closed draft; the answer stays in the page-level line and takes focus.
    // Wait for the refreshed page first (under load the refresh can land after the default 5 s), then the focus.
    await expect(page.locator('main header')).toContainText('Closed', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Reopen draft' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close draft' })).toHaveCount(0);
    const result = page.locator('[data-slot="draft-result"]');
    await expect(result).toContainText('Draft closed. Closed drafts stay readable and can be reopened.');
    await expect(result.locator('[tabindex="-1"]')).toBeFocused({ timeout: 15_000 });
  });

  test('Link to Bitrix: nothing preselected; choosing then confirming links; the answer is shown', async ({ page }) => {
    await open(page, 'b3-draft-link');
    const form = page.getByRole('form', { name: 'Link to a Bitrix deal' });
    const radios = form.getByRole('radio');
    await expect(radios).toHaveCount(3);
    for (const r of await radios.all()) await expect(r).not.toBeChecked();
    await expect(form.getByRole('radio', { name: /D-5090/ })).toBeDisabled();
    await expect(form).toContainText('That deal already has an accepted quotation.');
    await expect(form).toContainText('Made from the linked lead');
    // Pressing without a choice asks for one (no dialog).
    await form.getByRole('button', { name: 'Link to the chosen deal' }).click();
    await expect(form).toContainText('Choose the deal to link first.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await form.getByRole('radio', { name: /D-5109/ }).check();
    await form.getByRole('button', { name: 'Link to D-5109' }).click();
    const dialog = page.getByRole('dialog', { name: 'Link this draft to D-5109?' });
    await expect(dialog).toContainText('Sales on deal D-5109 will be able to open and change this draft, including the customer’s mobile and email. Nothing changes in Bitrix.');
    // Cancel returns focus to the button that opened the dialog (Echo-B L3).
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(form.getByRole('button', { name: 'Link to D-5109' })).toBeFocused();
    // Lead / Deal switch and the search are plain links and a GET form.
    await expect(page.getByRole('group', { name: 'Link to a lead or a deal' }).getByRole('link', { name: 'Lead' })).toHaveAttribute('href', /tab=link&kind=lead$/);
    await expect(page.getByRole('search', { name: 'Find a deal' })).toHaveAttribute('method', 'get');
    await form.getByRole('button', { name: 'Link to D-5109' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Link', exact: true }).click();
    // As in the real app the action redirects back: the form is gone, the link is listed and the result shows outside any form (Echo-B M1).
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Linked to D-5109. Nothing changed in Bitrix.' })).toBeVisible();
    await expect(page.locator('[data-slot="draft-result-notice"]')).toBeFocused();
    await expect(page.getByRole('form', { name: 'Link to a Bitrix deal' })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('This draft is already linked to deal D-5109. Remove the wrong link first to link another.');
    // As the route: no candidate read once a deal is linked (Echo N2), so no search either.
    await expect(page.getByRole('search', { name: 'Find a deal' })).toHaveCount(0);
    await expect(page.locator('main [data-slot="referral-link"]').first()).toContainText('Active link: Deal D-5109');
  });

  test('a refused link keeps the choice and says why (DA-65)', async ({ page }) => {
    await open(page, 'b3-draft-link-refused');
    const form = page.getByRole('form', { name: 'Link to a Bitrix deal' });
    await form.getByRole('radio', { name: /D-5110/ }).check();
    await form.getByRole('button', { name: 'Link to D-5110' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Link', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('That deal already has an accepted quotation.');
    await expect(form.getByRole('radio', { name: /D-5110/ })).toBeChecked();
  });

  test('no candidates: one honest line, no form', async ({ page }) => {
    await open(page, 'b3-draft-link-empty');
    await expect(page.locator('main')).toContainText('No leads or deals in this branch match.');
    await expect(page.getByRole('form', { name: 'Link to a Bitrix deal' })).toHaveCount(0);
  });

  test('Remove this link: reason and a 10–500 character note, confirmation, ended links stay in Earlier links', async ({ page }) => {
    await open(page, 'b3-draft-linked');
    const main = page.locator('main');
    await expect(main).toContainText('Deal D-5109');
    await expect(main).toContainText('Linked on 18 Oct 2026 by you');
    await main.getByText('Earlier links (1)').click();
    await expect(main).toContainText('Removed on 18 Oct 2026: Wrong customer');
    await main.getByRole('button', { name: 'Remove this link to D-5109' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the link to D-5109?' });
    await dialog.getByLabel('Wrong customer').check();
    await dialog.getByLabel(/^Note/).fill('too short');
    await dialog.getByRole('button', { name: 'Remove link' }).click();
    await expect(dialog.getByRole('alert').getByRole('link', { name: /Note: 10 to 500 characters/ })).toBeVisible();
    await expect(dialog.getByLabel('Wrong customer')).toBeChecked();
    await expect(dialog).toContainText('Sales on D-5109 lose access to this draft at once. The link stays in History.');
    await dialog.getByLabel(/^Note/).fill('Linked the brother’s deal by mistake.');
    await dialog.getByRole('button', { name: 'Remove link' }).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByRole('status').filter({ hasText: 'Link to D-5109 removed. You can link the right record now.' })).toBeVisible();
    await expect(main).toContainText('Not linked to Bitrix yet.');
    await expect(main.getByText('Earlier links (2)')).toBeVisible();
  });

  test('closed draft: read-only notice, no editing forms, Reopen is the one primary; a duplicate needs a note', async ({ page }) => {
    await open(page, 'b3-draft-closed');
    const main = page.locator('main');
    await expect(main.locator('header')).toContainText('Closed after 90 days without activity');
    await expect(main).toContainText('This draft is closed. Reopen it to make changes.');
    await expect(main.getByText('Edit customer details')).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Close draft' })).toHaveCount(0);
    expect(await primaries(page)).toBe(1);
    await open(page, 'b3-draft-closed-duplicate');
    await main.getByRole('button', { name: 'Reopen draft' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reopen this draft?' });
    await expect(dialog).toContainText('Needed because it was closed as a duplicate.');
    await dialog.getByRole('button', { name: 'Reopen draft' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toContainText('It can be changed again, with its quotations and itineraries. The 90 days without activity start again.');
    await dialog.getByLabel(/Why are you reopening it/).fill('Different traveller; same surname.');
    await dialog.getByRole('button', { name: 'Reopen draft' }).click();
    await expect(dialog).toBeHidden();
    await expect(main.locator('[data-slot="draft-result"]')).toContainText('Reopened. The 90 days start again. Closes on 19 Jan 2027 if nothing changes.');
    await expect(main.locator('header')).toContainText('Open');
    await expect(main).not.toContainText('This draft is closed.');
    // A closed draft's quotations tab offers no new quotation.
    await open(page, 'b3-draft-closed-quotations');
    await expect(main.getByRole('button', { name: 'Create quotation' })).toHaveCount(0);
  });

  test('closed draft: a wrong link can still be removed without reopening; no "reopen to remove" wording', async ({ page }) => {
    await open(page, 'b3-draft-closed-linked');
    const main = page.locator('main');
    await expect(main).toContainText('This draft is closed. Reopen it to make changes.');
    await expect(main.getByRole('button', { name: 'Remove this link to D-5109' })).toBeVisible();
    await expect(main).not.toContainText(/reopen it to remove/i);
    await main.getByRole('button', { name: 'Remove this link to D-5109' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the link to D-5109?' });
    await dialog.getByLabel('Wrong customer').check();
    await dialog.getByLabel(/^Note/).fill('Linked the wrong family by mistake.');
    await dialog.getByRole('button', { name: 'Remove link' }).click();
    await expect(main.getByRole('status').filter({ hasText: 'Link to D-5109 removed.' })).toBeVisible();
    await expect(main).toContainText('This draft is closed. Reopen it to make changes.');
    // No link step on a closed draft.
    await expect(page.getByRole('form', { name: 'Link to a Bitrix deal' })).toHaveCount(0);
  });

  test('Manager: paused automatic close, owner named, Change owner needs a person and a 10–500 reason', async ({ page }) => {
    await open(page, 'b3-draft-manager');
    const main = page.locator('main');
    await expect(main.locator('[data-slot="draft-auto-close"]')).toContainText('paused');
    await expect(main.locator('[data-slot="draft-auto-close"]')).not.toContainText(/\d{4}/);
    await expect(main.locator('header')).toContainText('Owner: Synthetic Sales Jodhpur');
    await main.getByRole('button', { name: 'Change owner' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change the owner of this draft' });
    await expect(dialog).toContainText('New owner must work in Sales in Jodhpur.');
    await dialog.getByRole('button', { name: 'Change owner' }).click();
    await expect(dialog.getByLabel('New owner')).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByLabel('New owner').selectOption({ label: 'Synthetic Sales Jodhpur B' });
    await dialog.getByLabel(/Why are you changing the owner/).fill('The salesperson is on leave for a month.');
    await dialog.getByRole('button', { name: 'Change owner' }).click();
    await expect(dialog).toBeHidden();
    await expect(main.locator('[data-slot="draft-result"]')).toContainText('Owner changed. The reason is recorded with your name.');
    await expect(main.locator('header')).toContainText('Owner: Synthetic Sales Jodhpur B');
  });

  test('link tab: a failed candidate read says so; a locked link never invites removing it; ready to book opens the quotation', async ({ page }) => {
    await open(page, 'b3-draft-link-load-error');
    const main = page.locator('main');
    await expect(main).toContainText('Leads and deals did not load. Nothing was changed. Reload the page to try again.');
    await expect(main.getByRole('search', { name: 'Find a deal' })).toBeVisible();
    await open(page, 'b3-draft-link-locked');
    await expect(main).toContainText('The link cannot be removed: a quotation from this draft is already tied to that deal for booking.');
    await expect(main).not.toContainText('Remove the wrong link first');
    await expect(main.getByRole('button', { name: /Remove this link/ })).toHaveCount(0);
    await expect(main.getByRole('search', { name: 'Find a deal' })).toHaveCount(0);
    await open(page, 'b3-draft-ready-to-book');
    await expect(main.getByRole('link', { name: 'Open TQ-7003 to start booking' })).toHaveAttribute('href', /\/app\/quotations\//);
    expect(await primaries(page)).toBe(1);
  });

  test('quotations and itineraries tabs list the draft’s work and add more', async ({ page }) => {
    await open(page, 'b3-draft-quotations');
    await expect(page.locator('#draft-quotations-table')).toContainText('TQ-7003');
    await expect(page.getByRole('button', { name: 'Create quotation' })).toBeVisible();
    await open(page, 'b3-draft-itineraries');
    await expect(page.locator('#draft-itineraries-table')).toContainText('Kerala backwaters plan');
    // DA-210: without a difference count the cell never claims "None".
    await expect(page.locator('#draft-itineraries-table')).toContainText('See the itinerary');
    await expect(page.locator('#draft-itineraries-table')).not.toContainText('None');
    await open(page, 'b3-draft-history');
    await expect(page.locator('main')).toContainText('Referral draft TD-301 created.');
  });

  test('not available: same words for missing and not yours; load error is not "not available"', async ({ page }) => {
    await open(page, 'b3-draft-not-available');
    await expect(page.locator('main')).toContainText('This referral draft is not available. It may not exist, or it is not shared with you.');
    await open(page, 'b3-draft-load-error');
    await expect(page.locator('main')).toContainText('This referral draft did not load');
    await expect(page.locator('main')).not.toContainText('not available');
  });
});

test.describe('Batch 3: Deal section, referral quotation, referral itinerary, Home', () => {
  test('Deal page: "Referral drafts for this deal" with the one-accepted note (DA-71)', async ({ page }) => {
    await open(page, 'b3-deal-referral-drafts');
    const section = page.getByRole('region', { name: 'Referral drafts for this deal' });
    await expect(section).toContainText('Only one quotation per deal can be accepted. Close the others as duplicates.');
    await expect(section.getByRole('link', { name: 'TD-301 · Sample Customer Mehra' })).toHaveAttribute('href', /\/app\/quotations\/drafts\//);
    await expect(section).toContainText('Another staff member');
  });

  test('accepted referral quotation, draft not linked: "Link to Bitrix Deal" opens the draft link tab; never converts', async ({ page }) => {
    await open(page, 'b3-quote-referral-accepted-unlinked');
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: 'Link to Bitrix deal' })).toHaveAttribute('href', /\/app\/quotations\/drafts\/.+\?tab=link$/);
    // F31: the waiting sentence appears once.
    expect(await main.getByText('Booking waits for the confirmed Bitrix deal', { exact: false }).count()).toBe(1);
    await expect(main.getByRole('button', { name: 'Start booking from this quotation' })).toHaveCount(0);
    await expect(main).toContainText('Booking waits for the confirmed Bitrix deal');
    for (const href of await main.getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) expect(href).not.toContain('undefined');
  });

  test('accepted referral quotation, draft linked: step 2 "Start booking from this quotation"', async ({ page }) => {
    await open(page, 'b3-quote-referral-accepted-linked');
    const main = page.locator('main');
    await expect(main.getByRole('button', { name: 'Start booking from this quotation' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Link to Bitrix deal' })).toHaveCount(0);
    await expect(main).toContainText('The draft is linked to the confirmed Bitrix deal D-5109. Starting the booking ties this quotation to that deal for good and starts one booking draft.');
  });

  test('referral quotation on a closed draft: read-only with the way to reopen', async ({ page }) => {
    await open(page, 'b3-quote-referral-closed');
    const main = page.locator('main');
    await expect(main).toContainText('This referral draft is closed. Reopen it to make changes.');
    await expect(main.getByRole('link', { name: 'Open referral draft TD-301' })).toHaveAttribute('href', /\/app\/quotations\/drafts\//);
  });

  test('referral itinerary: nothing to compare with yet, no prices (DA-80, DA-81); back to the draft', async ({ page }) => {
    await open(page, 'b3-itin-referral');
    const main = page.locator('main');
    await expect(main).toContainText('Type the trip details yourself. Once a quotation on this draft is accepted, you can compare.');
    await expect(main).toContainText('No prices: this itinerary has no accepted quotation.');
    await expect(main.getByRole('link', { name: 'Back to the referral draft' })).toHaveAttribute('href', /\/app\/quotations\/drafts\//);
  });

  test('Home: the two quotation rows open the Quotations list with the same filter in scope all', async ({ page }) => {
    await open(page, 'b3-home-sales');
    const needs = page.getByRole('region', { name: 'What needs you' });
    await expect(needs.getByRole('link', { name: /Quotation drafts to finish \(yours\)$/ })).toHaveAttribute('href', '/app/quotations?filter=to_finish&scope=all');
    await expect(needs.getByRole('link', { name: /Accepted quotations to link to a deal \(yours\)$/ })).toHaveAttribute('href', '/app/quotations?filter=accepted_not_linked&scope=all');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toContainText(['Home', 'Leads', 'Deals', 'Quotations', 'Itineraries']);
  });

  test('reduced motion: the dialogs and pages still work', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'b3-draft-linked');
    await page.getByRole('button', { name: 'Remove this link to D-5109' }).click();
    await expect(page.getByRole('dialog', { name: 'Remove the link to D-5109?' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove this link to D-5109' })).toBeFocused();
  });
});
