import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { pageReady } from '../helpers/page-ready';

/**
 * Phase 5A Accounts screens through the design-preview gallery (synthetic
 * props, no Supabase, stub actions that save nothing). Not evidence of a real
 * journey: the database half lives in tests/db/finance-*.test.ts and
 * tests/supabase/finance-*.real.test.ts.
 */

const states = [
  'finance-queue',
  'finance-loading',
  'finance-queue-truncated',
  'finance-queue-later-page',
  'finance-queue-end',
  'finance-queue-empty',
  'finance-queue-filter-empty',
  'finance-queue-lookup-found',
  'finance-queue-lookup-missing',
  'finance-deal-detail',
  // R4: the Accounts deal page has five tabs; each tab of the main fixture is checked too, and the
  // old ?tab=money address (it opens Receipts).
  'finance-deal-detail--receipts',
  'finance-deal-detail--dues',
  'finance-deal-detail--documents',
  'finance-deal-detail--refunds',
  'finance-deal-detail--review',
  'finance-deal-detail--money',
  'finance-deal-blocked--receipts',
  'finance-deal-record-open',
  'finance-deal-refunds-empty',
  'finance-deal-dues-error',
  'finance-deal-blocked',
  'finance-deal-not-live',
  'finance-deal-partly-live',
  'finance-deal-cash-off',
  'finance-deal-no-booking',
  'finance-deal-returned',
  'finance-deal-approved-after-return',
  'finance-deal-unknown-outcome',
  'finance-deal-not-found',
  'finance-cash',
  // R4 (A8): the second branch tab, and the deposit and cash count drawers open with a refusal.
  'finance-cash-jodhpur',
  'finance-cash-deposit-error',
  'finance-cash-count-error',
  'finance-cash-truncated',
  'finance-cash-awaiting-verification',
  'finance-cash-unavailable',
  'finance-cash-empty',
  'finance-policy',
  'finance-policy-error',
  'finance-policy-readonly',
  'finance-no-access',
  'finance-policy-no-access',
  'finance-not-configured',
];

const DISCLAIMER = 'Receipt numbers are internal. They are not tax invoices.';
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
  await pageReady(page);
}

/** R4: "Record a receipt" at the top of the deal page opens the existing form in a drawer (a dialog, outside main). */
async function recordDrawer(page: Page) {
  await page.getByRole('button', { name: 'Record a receipt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Record a receipt' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** R4: receipts are rows; each row's facts, proof files and other actions sit in its folded Details. */
async function openReceiptDetails(page: Page) {
  const folds = page.getByRole('main').locator('summary').filter({ hasText: /Details of receipt/ });
  for (const fold of await folds.all()) await fold.click();
}

const receiptsTable = (page: Page) => page.getByRole('table', { name: /Customer receipts/ });

test.describe('Phase 5A previews: accessibility and the disclaimer on desktop and 390 px', () => {
  for (const state of states) {
    test(`axe clean, one h1, disclaimer: ${state}`, async ({ page }) => {
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      // R1: a refused policy change opens its dialog again; the modal dialog hides the page (aria-modal),
      // so the page's own h1 and the disclaimer are found in the markup then.
      const dialogOpen = (await page.getByRole('dialog').count()) > 0;
      expect(await (dialogOpen ? page.locator('h1') : page.getByRole('heading', { level: 1 })).count()).toBe(1);
      await expect((dialogOpen ? page.locator('main') : page.getByRole('main')).getByText(DISCLAIMER)).toBeVisible();
    });
    test(`390 px, no sideways scroll: ${state}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, state);
      await noHorizontalScroll(page);
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('Phase 5A money and wording', () => {
  test('queue shows three separate figures per deal with en-IN grouping and no total', async ({ page }) => {
    await open(page, 'finance-queue');
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Available' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Awaiting verification' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Cheques awaiting clearance' })).toBeVisible();
    // 10000000000 paise = ₹10,00,00,000.00 (BigInt formatting, Indian grouping).
    await expect(table).toContainText('₹10,00,00,000.00');
    await expect(table).toContainText('₹42,000.50');
    await expect(page.getByRole('main')).not.toContainText(/total received|grand total/i);
    await expect(table.locator('tfoot')).toHaveCount(0);
  });

  test('deal detail shows the three figures separately and the read-only selling total', async ({ page }) => {
    // The old ?tab=money address opens Receipts, where the three figures now sit.
    await open(page, 'finance-deal-detail--money');
    await expect(page.getByRole('navigation', { name: 'Accounts deal sections' }).getByRole('link', { name: /^Receipts/ })).toHaveAttribute('aria-current', 'page');
    const money = page.getByRole('region', { name: 'Money for this deal' });
    await expect(money).toContainText('Available customer funds');
    await expect(money).toContainText('₹42,000.50');
    await expect(money).toContainText('₹40,000.00');
    await expect(money).toContainText('₹50,000.00');
    // The sum (₹1,32,000.50) is never shown.
    await expect(page.getByRole('main')).not.toContainText('₹1,32,000.50');
    await open(page, 'finance-deal-detail--review');
    await expect(page.getByRole('main')).not.toContainText('₹1,32,000.50');
    const booking = page.getByRole('region', { name: 'Booking and review' });
    await expect(booking).toContainText('₹1,23,456.00');
    await expect(booking).toContainText('Read-only. Accounts never changes the booking.');
    // Echo-B L5: the sum is never shown on any tab.
    for (const tab of ['receipts', 'dues', 'documents', 'refunds'] as const) {
      await open(page, `finance-deal-detail--${tab}`);
      await expect(page.getByRole('main'), tab).not.toContainText('₹1,32,000.50');
    }
  });

  test('every receipt status label from the contract appears', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const list = receiptsTable(page);
    for (const label of [
      'Awaiting verification',
      'Verified',
      'Cheque awaiting bank clearance',
      'Cleared',
      'Cheque bounced',
      'Cheque stopped',
      'Cheque cancelled',
      'Rejected (details entered wrongly)',
      'Rejected (money not received)',
      'Reversed (money not received)',
    ]) {
      await expect(list, label).toContainText(label);
    }
    // Awaiting receipts come first.
    await expect(list.locator('tbody').first()).toContainText('Awaiting verification');
  });

  test('blocked actions show the contract reason next to an unavailable button', async ({ page }) => {
    await open(page, 'finance-deal-blocked--receipts');
    let main = page.getByRole('main');
    await openReceiptDetails(page);
    for (const reason of [
      'You recorded this receipt. Another Accounts person must do this step.',
      'You verified this receipt. Another Accounts person must reverse it.',
      'You own or sell this deal, so another Accounts person must do this step.',
      'Upload the required proof first.',
      'This cash is in a deposit awaiting verification. Verify or reject the deposit first.',
    ]) {
      await expect(main.getByText(reason).first(), reason).toBeVisible();
    }
    const verify = main.getByRole('button', { name: 'Verify receipt' }).first();
    await expect(verify).toHaveAttribute('aria-disabled', 'true');
    await expect(verify).toHaveAccessibleDescription('You recorded this receipt. Another Accounts person must do this step.');
    // The Deal owner or seller never approves their own deal's booking (Review tab).
    await open(page, 'finance-deal-blocked--review');
    main = page.getByRole('main');
    const approve = main.getByRole('button', { name: 'Approve booking' });
    await expect(approve).toHaveAttribute('aria-disabled', 'true');
    await expect(approve).toHaveAccessibleDescription('You own or sell this deal, so another Accounts person must do this step.');
    await expect(main.getByRole('form', { name: 'Approve booking review' })).toHaveCount(0);
  });

  test('a cheque that needs bank proof shows why clearing is unavailable', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    await openReceiptDetails(page);
    const clear = page.getByRole('button', { name: 'Record cheque cleared' });
    await expect(clear).toHaveAttribute('aria-disabled', 'true');
    await expect(clear).toHaveAccessibleDescription('Upload the required proof first.');
    await expect(page.getByRole('button', { name: 'Re-present cheque' })).toHaveAccessibleDescription('This payment mode is not live yet.');
  });

  test('return reasons are said to reach Sales in Book now (older ones stay inside Accounts)', async ({ page }) => {
    await open(page, 'finance-deal-returned--review');
    await expect(page.getByRole('main')).toContainText('Return reason:');
    await expect(page.getByRole('main')).toContainText('Sales sees return reasons in Book now. Only reasons recorded before Sales could see them stay inside Accounts');
    await expect(page.getByRole('main')).not.toContainText('visible inside Accounts only');
    await page.getByText('Return to Sales with a reason').click();
    await expect(page.getByRole('main')).toContainText('Sales sees this reason on the booking in Book now.');
    await expect(page.getByRole('main')).not.toContainText('Sales does not see it');
  });

  test('not-live modes: honest status and no working record button', async ({ page }) => {
    await open(page, 'finance-deal-not-live--receipts');
    const record = await recordDrawer(page);
    await expect(record).toContainText('No payment mode is available yet.');
    const modes = record.getByRole('group', { name: 'How did the customer pay?' });
    await expect(modes.getByText('Not available yet', { exact: true })).toHaveCount(4);
    const button = record.getByRole('button', { name: 'Record receipt' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription('This payment mode is not live yet.');
  });

  test('partly live: live modes record, others explain', async ({ page }) => {
    await open(page, 'finance-deal-partly-live--receipts');
    const record = await recordDrawer(page);
    await expect(record.getByRole('button', { name: 'Record bank transfer receipt' })).toBeVisible();
    await record.getByRole('radio', { name: /Cheque/ }).check();
    await expect(record.getByRole('button', { name: 'Record receipt' })).toHaveAttribute('aria-disabled', 'true');
    await record.getByRole('radio', { name: /UPI/ }).check();
    await expect(record.getByLabel('UPI transaction reference')).toBeVisible();
  });

  test('record form fields follow the mode; cash shows the policy caps', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = await recordDrawer(page);
    await expect(record).toContainText('One receipt can be at most ₹1,00,00,000.00.');
    await expect(record.getByLabel('Bank reference (UTR)')).toBeVisible();
    await record.getByRole('radio', { name: /Cash/ }).check();
    await expect(record).toContainText('Cash from one payer on one day, across all branches: at most ₹49,999.00.');
    await expect(record).toContainText('Cash for this trip in total: at most ₹49,999.00.');
    await expect(record.getByLabel('Who collected the cash')).toBeVisible();
    await expect(record.getByLabel('Bank reference (UTR)')).toHaveCount(0);
    await record.getByRole('radio', { name: /Cheque/ }).check();
    await expect(record.getByLabel('MICR code')).toBeVisible();
    await expect(record.getByLabel('Cheque number')).toBeVisible();
    await expect(record.getByLabel(/Account payee/)).toBeVisible();
    await expect(record.getByLabel('Payer PAN')).toBeVisible();
    await expect(record.getByLabel('Payer mobile')).toBeVisible();
  });

  test('cash off by policy explains itself', async ({ page }) => {
    await open(page, 'finance-deal-cash-off--receipts');
    const record = await recordDrawer(page);
    await record.getByRole('radio', { name: /Cash/ }).check();
    await expect(record.getByText(/Cash is switched off by company policy/).first()).toBeVisible();
    await expect(record.getByRole('button', { name: 'Record receipt' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('a stub submit answers with an error and keeps typed values (no fake success)', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = await recordDrawer(page);
    await record.getByLabel('Amount received (₹)').fill('1234.50');
    await record.getByLabel('Payer name').fill('Synthetic Payer Z');
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('Design preview: nothing is saved.');
    await expect(record.getByLabel('Amount received (₹)')).toHaveValue('1234.50');
    await expect(record.getByLabel('Payer name')).toHaveValue('Synthetic Payer Z');
    await expect(record.getByRole('status').filter({ hasText: 'Done:' })).toHaveCount(0);
  });

  test('cash page: overdue, stale and custody items, deposits and counts', async ({ page }) => {
    await open(page, 'finance-cash');
    const delhi = page.getByRole('region', { name: 'Delhi' });
    for (const text of [
      'Verified cash not deposited in time',
      'Cash recorded but not verified in time',
      'Reversed cash still at the branch',
      'Daily cash count missing',
      'Daily cash count awaiting verification',
      'Verified cash count is out of date',
      'Out of date: count again',
    ]) {
      await expect(delhi.getByText(text).first(), text).toBeVisible();
    }
    await expect(delhi).toContainText('Verified cash in hand');
    await expect(delhi).toContainText('Cash recorded, not verified');
    await expect(delhi.getByRole('button', { name: 'Verify deposit SYN-DEP-0007' })).toBeVisible();
    await expect(delhi.getByText('You recorded this deposit. Another Accounts person must do this step.').first()).toBeVisible();
    await expect(delhi).toContainText('−₹100.00');
    // R4 (A8): one branch at a time, as a tab per branch; the page opens on the first branch with work (Delhi).
    await expect(page.getByRole('region', { name: 'Jodhpur' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Branches' }).getByRole('link', { name: /^Jodhpur/ })).toBeVisible();
    await open(page, 'finance-cash-jodhpur');
    await expect(page.getByRole('region', { name: 'Jodhpur' })).toContainText('Nothing unresolved at this branch.');
  });

  test('policy page (R1): summary on top, one Change opening the edit form, scheduled changes, history folded', async ({ page }) => {
    await open(page, 'finance-policy');
    await expect(page.getByRole('region', { name: 'Current policy' })).toContainText('Version 2 in force');
    await expect(page.getByRole('region', { name: 'Legal ceilings' })).toContainText('₹1,99,999.00');
    await expect(page.getByRole('region', { name: 'Legal ceilings' }).getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Scheduled policy versions' })).toContainText('Version 3 · scheduled');
    // History is folded; opening it shows every version.
    await expect(page.getByRole('list', { name: 'Policy versions, newest first' })).toBeHidden();
    await page.locator('#pol-history summary').click();
    await expect(page.getByRole('list', { name: 'Policy versions, newest first' }).getByRole('listitem')).toHaveCount(2);
    // The form is not on the page until "Change the policy" opens it.
    await expect(page.getByRole('form', { name: 'Schedule a new policy version' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Change the policy' }).click();
    const form = page.getByRole('dialog', { name: 'Change the policy' }).getByRole('form', { name: 'Schedule a new policy version' });
    await expect(form.getByLabel('Reason for the change')).toBeVisible();
    await expect(form.getByLabel('Takes effect at (IST)')).toBeVisible();
    await expect(form.getByLabel('Largest single receipt (₹)')).toHaveValue('10000000');
  });

  test('policy error state marks the exact fields (the dialog opens again with the refusal)', async ({ page }) => {
    await open(page, 'finance-policy-error');
    const form = page.getByRole('dialog', { name: 'Change the policy' }).getByRole('form', { name: 'Schedule a new policy version' });
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(form.getByLabel('Cash per trip (₹)')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByLabel('Cash per trip (₹)')).toHaveAccessibleDescription(/legal ceiling/);
    await expect(form.getByLabel('Reason for the change')).toHaveAttribute('aria-invalid', 'true');
  });

  test('navigation: the Accounts group for Accounts staff, Money rules under Settings for the owner', async ({ page }) => {
    await open(page, 'finance-queue');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'To check', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('group', { name: 'Accounts' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await open(page, 'finance-policy');
    await expect(nav.getByRole('group', { name: 'Settings' }).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Money rules' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'To check', exact: true })).toHaveCount(0);
    await open(page, 'finance-no-access');
    await expect(nav.getByRole('link', { name: 'To check', exact: true })).toHaveCount(0);
  });
});

test.describe('Phase 5A keyboard', () => {
  test('queue filters and the one search are reachable by keyboard with the current filter marked', async ({ page }) => {
    await open(page, 'finance-queue-lookup-found');
    const filters = page.getByRole('navigation', { name: 'To check filters' });
    await expect(filters.getByRole('link', { name: /^Booking reviews/ })).toHaveAttribute('aria-current', 'page');
    const input = page.getByRole('searchbox', { name: 'Find a deal by its exact reference' });
    await expect(input).toHaveValue('SYN-JDH-009');
    await input.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('search', { name: 'Find a deal to check' }).getByRole('button', { name: 'Search' })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'SYN-JDH-009' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open SYN-JDH-009' })).toHaveAttribute('href', '/app/accounts/deals/d5000000-0000-4000-8000-000000000009');
  });

  test('payment mode radios change with arrow keys and reveal the right fields', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = await recordDrawer(page);
    const bank = record.getByRole('radio', { name: /Bank transfer/ });
    await bank.focus();
    await page.keyboard.press('ArrowRight');
    await expect(record.getByRole('radio', { name: /UPI/ })).toBeChecked();
    await expect(record.getByLabel('UPI transaction reference')).toBeVisible();
  });

  test('a reject form opens from the keyboard and focuses into its fields', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    await openReceiptDetails(page);
    const summary = page.locator('summary').filter({ hasText: 'Reject receipt' }).first();
    await summary.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('What happened').first()).toBeFocused();
  });
});

test.describe('Phase 5A retry identity and review states', () => {
  test('a refusal with a known token issues a new requestId; values stay', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = await recordDrawer(page);
    const form = record.getByRole('form', { name: 'Record a receipt' });
    const before = await form.locator('input[name="requestId"]').inputValue();
    await record.getByLabel('Payer name').fill('Synthetic Payer Y');
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('Design preview: nothing is saved.');
    await expect(form.locator('input[name="requestId"]')).not.toHaveValue(before);
    await expect(record.getByLabel('Payer name')).toHaveValue('Synthetic Payer Y');
  });

  test('an unknown outcome keeps the same requestId so a resubmit replays', async ({ page }) => {
    await open(page, 'finance-deal-unknown-outcome--receipts');
    const record = await recordDrawer(page);
    const form = record.getByRole('form', { name: 'Record a receipt' });
    const before = await form.locator('input[name="requestId"]').inputValue();
    await record.getByLabel('Amount received (₹)').fill('500');
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('We could not confirm this was saved.');
    await expect(form.locator('input[name="requestId"]')).toHaveValue(before);
    await expect(record.getByLabel('Amount received (₹)')).toHaveValue('500');
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('We could not confirm this was saved.');
    await expect(form.locator('input[name="requestId"]')).toHaveValue(before);
  });

  // R4 review P2-2: the drawer unmounts its content when it closes; the form state lives above it, so a
  // resubmit after reopening still replays the same request (no second cash or bank receipt).
  test('closing and reopening the receipt drawer after an unknown outcome posts the same requestId', async ({ page }) => {
    await open(page, 'finance-deal-unknown-outcome--receipts');
    let record = await recordDrawer(page);
    const before = await record.getByRole('form', { name: 'Record a receipt' }).locator('input[name="requestId"]').inputValue();
    await record.getByLabel('Amount received (₹)').fill('500');
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('We could not confirm this was saved.');
    await page.keyboard.press('Escape');
    await expect(record).toBeHidden();
    record = await recordDrawer(page);
    const form = record.getByRole('form', { name: 'Record a receipt' });
    await expect(form.locator('input[name="requestId"]')).toHaveValue(before);
    await expect(record.getByLabel('Amount received (₹)')).toHaveValue('500');
    const posted = page.waitForRequest((r) => r.method() === 'POST' && (r.postData() ?? '').includes(before));
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await posted;
    await expect(record.getByRole('alert')).toContainText('We could not confirm this was saved.');
  });

  test('an approved review never shows an earlier return reason as current', async ({ page }) => {
    await open(page, 'finance-deal-approved-after-return--review');
    const booking = page.getByRole('region', { name: 'Booking and review' });
    await expect(booking).toContainText('Approved by Accounts');
    await expect(booking).not.toContainText('Return reason');
    await expect(booking).not.toContainText('Old reason from before the fix');
    await expect(booking.getByRole('button', { name: 'Approve booking' })).toHaveCount(0);
  });

  test('cash page says reversed cash custody is resolved outside the CRM', async ({ page }) => {
    await open(page, 'finance-cash');
    const delhi = page.getByRole('region', { name: 'Delhi' });
    await expect(delhi).toContainText('Settle it with the branch and the owner; it stays listed here.');
    await expect(delhi).toContainText('Physical cash held for reversed receipts is not included');
  });
});

test.describe('R4 To check and the Accounts view of a Deal', () => {
  test('To check: section tabs under the header, one search, filter chips and one row button per deal', async ({ page }) => {
    await open(page, 'finance-queue');
    const main = page.getByRole('main');
    // D5: the section tabs sit under the page header, not above it.
    const sections = main.getByRole('navigation', { name: 'To check sections' }).last();
    await expect(sections.getByRole('link', { name: /^To check/ })).toHaveAttribute('aria-current', 'page');
    const h1Box = await page.getByRole('heading', { level: 1 }).boundingBox();
    const tabsBox = await sections.boundingBox();
    expect(tabsBox!.y).toBeGreaterThan(h1Box!.y);
    // One search field; the old "Find a deal by reference" card and the "Also in Accounts" links are gone.
    await expect(main.getByRole('searchbox')).toHaveCount(1);
    await expect(main.getByRole('heading', { name: 'Find a deal by reference' })).toHaveCount(0);
    await expect(main).not.toContainText('Also in Accounts');
    // Every ?filter= value stays reachable (four chips, the rest under More).
    const chips = main.getByRole('navigation', { name: 'To check filters' });
    await expect(chips.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'page');
    // The summary reads "More filters" (the word "filters" is for screen readers only).
    await main.getByText('More filters', { exact: true }).click();
    await expect(main.getByRole('link', { name: /Cheques awaiting clearance/ })).toHaveAttribute('href', '/app/accounts?filter=cheques_pending');
    // One row button, named with its deal, opening the tab of the next step.
    const table = main.getByRole('table');
    await expect(table.getByRole('link', { name: 'Verify SYN-DEL-001' })).toHaveAttribute('href', '/app/accounts/deals/d5000000-0000-4000-8000-000000000001?tab=receipts');
    await expect(table.getByRole('link', { name: 'Review SYN-DEL-002' })).toHaveAttribute('href', '/app/accounts/deals/d5000000-0000-4000-8000-000000000002?tab=review');
    await expect(table.getByRole('link', { name: 'Open SYN-AMD-005' })).toHaveAttribute('href', '/app/accounts/deals/d5000000-0000-4000-8000-000000000005?tab=receipts');
  });

  test('the recorder sees Verify disabled with the reason on their own receipt, and the header names who acts', async ({ page }) => {
    await open(page, 'finance-deal-blocked--receipts');
    const row = receiptsTable(page).locator('tbody').filter({ hasText: 'R-2026-27-000001' });
    const verify = row.getByRole('button', { name: 'Verify receipt R-2026-27-000001' });
    await expect(verify).toBeVisible();
    await expect(verify).toHaveAttribute('aria-disabled', 'true');
    await expect(verify).toHaveAccessibleDescription('You recorded this receipt. Another Accounts person must do this step.');
    // The reason is shown in words next to the button (the row's folded "More actions" repeats it for Reject).
    const reasonId = await verify.getAttribute('aria-describedby');
    await expect(row.locator(`[id="${reasonId}"]`)).toBeVisible();
    await expect(row.locator(`[id="${reasonId}"]`)).toContainText('You recorded this receipt. Another Accounts person must do this step.');
    await expect(page.getByRole('form', { name: 'Verify R-2026-27-000001' })).toHaveCount(0);
    // Clicking the disabled button does nothing. Playwright waits for an aria-disabled button to become
    // enabled, so the click is forced: it still reaches the button, and nothing may open.
    await verify.click({ force: true });
    await expect(page.getByRole('form', { name: 'Verify R-2026-27-000001' })).toHaveCount(0);
    // With nothing this person can verify, "Record a receipt" is the page's one primary action.
    await expect(page.getByRole('button', { name: 'Record a receipt', exact: true })).toHaveClass(/\bbg-brand-strong\b/);
  });

  test('a second Accounts person verifies from the row; the header Next jumps to that Verify button', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const next = page.locator('[data-slot="next-step"]');
    await expect(next).toContainText('verify receipt R-2026-27-000001');
    await next.getByRole('link', { name: /Verify receipt/ }).click();
    const verify = page.getByRole('button', { name: 'Verify receipt R-2026-27-000001' });
    await expect(verify).toBeFocused();
    await expect(verify).toHaveAttribute('aria-disabled', 'false');
    // The stub action saves nothing and says so in the row.
    await verify.click();
    await expect(page.getByRole('form', { name: 'Verify R-2026-27-000001' }).getByRole('alert')).toContainText('Design preview: nothing is saved.');
  });

  test('Record a receipt opens the existing form in a drawer; Escape closes it and focus returns to the button', async ({ page }) => {
    await open(page, 'finance-deal-detail--review');
    const dialog = await recordDrawer(page);
    await expect(dialog.getByRole('form', { name: 'Record a receipt' })).toBeVisible();
    // Same field names as the inline form posted before.
    for (const name of ['requestId', 'dealId', 'mode', 'amountRupees', 'receivedOn', 'payerName']) {
      await expect(dialog.locator(`[name="${name}"]`).first(), name).toBeAttached();
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Record a receipt', exact: true })).toBeFocused();
  });

  test('five tabs; the old Money address opens Receipts; Dues and plan and Refunds show their cards and lists', async ({ page }) => {
    await open(page, 'finance-deal-detail--money');
    const tabs = page.getByRole('navigation', { name: 'Accounts deal sections' });
    await expect(tabs.getByRole('link')).toHaveText([/^Receipts/, /^Dues and plan/, /^Documents/, /^Refunds/, /^Review/]);
    await expect(page.locator('[data-slot="accounts-deal-tab"]')).toHaveAttribute('data-tab', 'receipts');
    await open(page, 'finance-deal-detail--dues');
    await expect(page.getByRole('region', { name: 'Customer dues' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Customer dues' })).toHaveAttribute('href', '/app/accounts/dues');
    await open(page, 'finance-deal-dues-error');
    await expect(page.getByRole('main')).toContainText('The dues could not be loaded just now.');
    await open(page, 'finance-deal-refunds-empty');
    await expect(page.getByRole('heading', { name: 'No refunds on this deal' })).toBeVisible();
    // The way to the Refunds list in the tab's text (the Refunds tab link has the same name).
    await expect(page.getByRole('main').getByText(/Refunds are paid and verified on/).getByRole('link', { name: 'Refunds', exact: true })).toHaveAttribute('href', '/app/accounts/refunds');
  });

  test('no "Not possible now" list on receipt rows', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    await openReceiptDetails(page);
    await expect(page.getByRole('main')).not.toContainText('Not possible now');
    await expect(page.getByRole('main')).not.toContainText('Not possible in the current state:');
  });
});
