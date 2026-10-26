import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, axe, COMMERCIAL_WORDS, cspSuite, noHorizontalScroll, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * Batch 4 department screens (Direction A R7; DA-16, DA-270 to DA-273;
 * money-privacy-settings §10 T-B4-01 to T-B4-10 and T-B4-13) on the preview
 * gallery: Purchase, Flight and Visa task lists with Not taken · Mine · All,
 * and task pages with Details · Work · Files · History. Synthetic props and
 * stand-in actions only: not evidence of a real journey (the database half is
 * the department task reads and Atlas's History suite).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const LISTS = [
  'b4-purchase-queue',
  'b4-purchase-queue-mine',
  'b4-purchase-queue-all',
  'b4-purchase-queue-manager',
  'b4-purchase-queue-empty',
  'b4-purchase-queue-mine-empty',
  'b4-flight-queue',
  'b4-flight-queue-mine',
  'b4-flight-queue-all',
  'b4-visa-queue',
  'b4-visa-queue-all',
  'b4-visa-queue-off',
  'b4-visa-queue-unknown',
];
const TASKS = [
  'b4-purchase-task-details',
  'b4-purchase-task-work',
  'b4-purchase-task-files',
  'b4-purchase-task-files-empty',
  'b4-purchase-task-files-id-error',
  'b4-purchase-task-history',
  'b4-purchase-task-history-empty',
  'b4-purchase-task-history-error',
  'b4-purchase-task-history-not-installed',
  'b4-purchase-task-not-taken',
  'b4-purchase-task-confirmed',
  'b4-purchase-task-manager',
  'b4-purchase-task-manager-details',
  'b4-purchase-task-sales',
  'b4-flight-task-details',
  'b4-flight-task-work',
  'b4-flight-task-files',
  'b4-flight-task-history',
  'b4-flight-task-not-taken',
  'b4-visa-task-details',
  'b4-visa-task-work',
  'b4-visa-task-files',
  'b4-visa-task-history',
  'b4-visa-task-not-taken',
];
const ALL = [...LISTS, ...TASKS];

/** booking-form-2026-10-22/money-privacy-copy.md §B search strings and the Batch 4 key names (T-B4-01 to T-B4-08). */
const NEVER_IN_HTML = [/12,345\.67/, /2,345\.67/, /24,691\.34/, /sellingTotal/, /selling_total/, /margin/i, /markup/i, /paymentPlan/, /instalments/, /"claims"/, /"receipts"/, /finance_evidence/, /acceptance_message/, /(?<!direct_)payment_proof/, /synthetic-acceptance/];
// `direct_payment_proof` is the department's own company-payment proof (allowed, T-B4-07); the customer's `payment_proof` never appears.
/** The Files tab states the rule in words (DA-270); a rule is not data. */
const FILES_RULE = 'Only files for this task. Customer payment proofs and acceptance messages are never listed here.';

accessibilitySuite('Batch 4 department screens: accessibility (1440, 390, 200 % zoom)', ALL);
cspSuite('Batch 4 department screens: production style policy', ALL);

test.describe('Batch 4 department screens at 375 px', () => {
  for (const state of ALL) {
    test(`375 px: axe clean, no sideways scroll: ${state}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: 375, height: 812 });
      await open(page, state);
      await noHorizontalScroll(page, state);
      expect(await axe(page), `${state} at 375`).toEqual([]);
    });
  }
});

test.describe('Batch 4 department privacy (money-privacy-settings §10)', () => {
  for (const state of ALL) {
    test(`no selling price, margin, plan, reported payment, receipt or customer proof in page text or raw HTML: ${state}`, async ({ page }) => {
      await open(page, state);
      const text = await page.locator('main').innerText();
      for (const word of COMMERCIAL_WORDS) expect(text, `${state}: ${word}`).not.toMatch(word);
      // Raw server HTML includes the RSC payload sent to the browser (T-B4-08: only the open tab's data).
      const html = (await (await page.request.get(`/preview/${state}`)).text()).replace(FILES_RULE, '');
      for (const word of NEVER_IN_HTML) expect(html, `${state}: ${word}`).not.toMatch(word);
    });
  }

  test('task tabs never carry a count and there is no Money tab (T-B4-08)', async ({ page }) => {
    for (const state of TASKS.filter((s) => !s.endsWith('-sales'))) {
      await open(page, state);
      const tabs = page.getByRole('navigation', { name: 'Task sections' });
      await expect(tabs.getByRole('link'), state).toHaveText(['Details', 'Work', 'Files', 'History']);
      await expect(tabs.getByRole('link', { name: 'Money' })).toHaveCount(0);
    }
  });

  test('Sales opening a Purchase task gets status only: no tab bar, no Purchase work or files (R11)', async ({ page }) => {
    await open(page, 'b4-purchase-task-sales');
    const main = page.locator('main');
    await expect(page.getByRole('navigation', { name: 'Task sections' })).toHaveCount(0);
    await expect(main).toContainText('Confirmed by supplier');
    await expect(main).toContainText('Nothing waiting.');
    for (const hidden of ['Supplier offers', 'Cost history', 'Purchase files', 'SYN-CONF-0001', 'Synthetic Stays', 'Traveller ID proofs']) await expect(main).not.toContainText(hidden);
    const html = await (await page.request.get('/preview/b4-purchase-task-sales')).text();
    expect(html).not.toContain('/app/purchase/files/');
  });

  test('Files lists only this task’s files through the audited routes (T-B4-04)', async ({ page }) => {
    await open(page, 'b4-purchase-task-files');
    const main = page.locator('main');
    await expect(main).toContainText(FILES_RULE);
    const purchaseFiles = main.getByRole('list', { name: 'Purchase files' });
    // Stored files only: the failed upload is not offered for download.
    await expect(purchaseFiles.getByRole('link')).toHaveCount(1);
    await expect(purchaseFiles.getByRole('link', { name: 'synthetic-quote.pdf' })).toHaveAttribute('href', /^\/app\/purchase\/files\//);
    await expect(main.getByRole('list', { name: 'Traveller ID proofs' }).getByRole('link')).toHaveCount(1);
    await open(page, 'b4-purchase-task-files-empty');
    await expect(page.locator('main')).toContainText('No files on this task yet.');
    await open(page, 'b4-purchase-task-files-id-error');
    await expect(page.locator('main')).toContainText('The ID proofs could not be loaded just now.');
  });

  test('History: only this task, names only "you" or people already shown, failure never reads as "none" (T-B4-05)', async ({ page }) => {
    await open(page, 'b4-purchase-task-history');
    const history = page.getByRole('list', { name: 'Task history, newest first' });
    await expect(history.getByRole('listitem')).toHaveCount(6);
    await expect(history).toContainText('Task moved to you');
    await expect(history).toContainText('by Another staff member');
    await expect(history).toContainText('by you');
    await expect(history).not.toContainText('₹');
    await open(page, 'b4-purchase-task-history-empty');
    await expect(page.locator('main')).toContainText('No history you can see on this task yet.');
    await open(page, 'b4-purchase-task-history-error');
    await expect(page.locator('main').getByRole('status')).toContainText('History did not load. Nothing was changed.');
    await expect(page.locator('main')).not.toContainText('No history you can see');
    await open(page, 'b4-purchase-task-history-not-installed');
    await expect(page.locator('main').getByRole('status')).toContainText('History is not available in this CRM yet.');
  });

  test('a branch Manager reads Purchase work read-only and never sees prices', async ({ page }) => {
    await open(page, 'b4-purchase-task-manager');
    const main = page.locator('main');
    await expect(main).toContainText('You can view this but not change it. Purchase in Delhi works on it.');
    await expect(main.getByRole('button', { name: 'Record supplier confirmation' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: /Approve this cost above budget/ })).toBeVisible();
    await expect(main).not.toContainText(/selling|margin/i);
  });
});

test.describe('Batch 4 department lists: Not taken · Mine · All', () => {
  test('tabs are links; the current one is marked in words and aria-current; counts from the rows shown', async ({ page }) => {
    await open(page, 'b4-purchase-queue');
    const filters = page.getByRole('navigation', { name: 'Purchase task filters' });
    await expect(filters.getByRole('link')).toHaveCount(3);
    await expect(filters.getByRole('link', { name: /^Not taken/ })).toHaveAttribute('aria-current', 'page');
    await expect(filters.getByRole('link', { name: /^Mine/ })).toHaveAttribute('href', '/app/purchase?show=mine');
    await expect(filters.getByRole('link', { name: /^All/ })).toContainText('4');
    await expect(page.getByRole('table', { name: '2 tasks' })).toBeVisible();
    await open(page, 'b4-purchase-queue-all');
    await expect(page.getByRole('table', { name: '4 tasks' })).toContainText('Budget not set');
    await expect(page.locator('main')).not.toContainText('₹0.00');
    await pillsHaveIconAndWord(page);
  });

  test('the branch Manager gets Not taken and All only, starting on All', async ({ page }) => {
    await open(page, 'b4-purchase-queue-manager');
    const filters = page.getByRole('navigation', { name: 'Purchase task filters' });
    await expect(filters.getByRole('link')).toHaveCount(2);
    await expect(filters.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'page');
  });

  test('keyboard: the tab links are reachable in order and show a focus ring', async ({ page }) => {
    await open(page, 'b4-flight-queue');
    const filters = page.getByRole('navigation', { name: 'Flight task filters' });
    await filters.getByRole('link', { name: /^Not taken/ }).focus();
    await page.keyboard.press('Tab');
    await expect(filters.getByRole('link', { name: /^Mine/ })).toBeFocused();
    const outline = await filters.getByRole('link', { name: /^Mine/ }).evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });

  test('empty list and empty tab say why', async ({ page }) => {
    await open(page, 'b4-purchase-queue-empty');
    await expect(page.locator('main').getByRole('status')).toContainText('Tasks appear after Sales submits a booking with a hotel, transfer or activity.');
    await open(page, 'b4-purchase-queue-mine-empty');
    await expect(page.locator('main').getByRole('status')).toContainText('No tasks taken by you');
  });

  test('Visa desk: Off says not started; Unknown says it could not be read and never "not started"', async ({ page }) => {
    await open(page, 'b4-visa-queue-off');
    await expect(page.locator('main')).toContainText('Not started yet');
    await expect(page.locator('main')).toContainText('The Visa desk is not started yet.');
    await open(page, 'b4-visa-queue-unknown');
    const main = page.locator('main');
    await expect(main).toContainText('Desk state could not be read');
    await expect(main).not.toContainText('Not started yet');
    await expect(main).not.toContainText('Not launched yet');
    await expect(main.getByRole('link', { name: /Visa · United Arab Emirates/ })).toBeVisible();
  });
});

test.describe('Batch 4 department task pages', () => {
  test('header: status word with icon, taken by, one Next line, one primary', async ({ page }) => {
    await open(page, 'b4-purchase-task-details');
    const main = page.locator('main');
    await expect(main.locator('[data-slot="task-next"]')).toHaveText('Next: record the supplier’s confirmation');
    await expect(main).toContainText('Taken by: You');
    await expect(main.getByRole('link', { name: 'Record supplier confirmation' })).toHaveAttribute('href', /\?tab=work$/);
    await expect(main.getByRole('heading', { name: 'Traveller ID proofs' })).toBeVisible();
    await pillsHaveIconAndWord(page);
    // Who acts next / Next step cards are gone (G-18).
    await expect(main).not.toContainText('Who acts next');
    await open(page, 'b4-purchase-task-work');
    // On Work the confirmation button is the one primary; the header link is not repeated.
    await expect(page.locator('main').getByRole('link', { name: 'Record supplier confirmation' })).toHaveCount(0);
    await expect(page.locator('main').getByRole('button', { name: 'Record supplier confirmation' })).toHaveCount(1);
    await expect(page.locator('main')).toContainText('Budget: ₹45,000.00. Payments are not made from here.');
    // R13: the proof upload stays on Work, next to the confirmation.
    await expect(page.locator('main').getByRole('form', { name: 'Upload a Purchase file' })).toBeVisible();
  });

  test('not taken: Take this task is the one primary', async ({ page }) => {
    for (const state of ['b4-purchase-task-not-taken', 'b4-flight-task-not-taken', 'b4-visa-task-not-taken']) {
      await open(page, state);
      const main = page.locator('main');
      await expect(main.getByRole('button', { name: 'Take this task' }), state).toHaveCount(1);
      await expect(main.locator('[data-slot="task-next"]'), state).toHaveText('Next: take this task');
    }
  });

  test('Flight: details keep F-04; Work holds the cost with the returned reason; Files list the screenshot', async ({ page }) => {
    await open(page, 'b4-flight-task-details');
    await expect(page.getByRole('region', { name: 'Travellers and budget' })).toContainText('Sample Traveller A');
    await open(page, 'b4-flight-task-not-taken');
    await expect(page.getByRole('region', { name: 'Travellers and budget' })).toContainText('Traveller names are not shown to the Flight team in this version.');
    await open(page, 'b4-flight-task-work');
    await expect(page.getByRole('region', { name: 'Cost' })).toContainText('Accounts returned it');
    await open(page, 'b4-flight-task-files');
    await expect(page.locator('main').getByRole('list', { name: 'Flight screenshots' }).getByRole('link')).toHaveCount(1);
    await open(page, 'b4-flight-task-history');
    await expect(page.getByRole('list', { name: 'Task history, newest first' })).toContainText('Accounts returned the cost');
  });

  test('Visa: Work holds the applicant checklist and stage list (G15); Details holds the private notice', async ({ page }) => {
    await open(page, 'b4-visa-task-details');
    await expect(page.locator('main')).toContainText('Private applicant documents');
    await expect(page.locator('main').getByRole('link', { name: 'Continue the applications' })).toHaveAttribute('href', /\?tab=work$/);
    await open(page, 'b4-visa-task-work');
    await expect(page.locator('main').getByRole('list', { name: 'Progress for Sample Traveller A' })).toBeVisible();
    await expect(page.locator('main').getByRole('button', { name: 'Record submission' })).toBeVisible();
    await open(page, 'b4-visa-task-history');
    await expect(page.getByRole('list', { name: 'Task history, newest first' })).toContainText('Applicant 1: Submitted');
  });
});
