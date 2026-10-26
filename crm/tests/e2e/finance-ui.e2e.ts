import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

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
  // Batch 4: the Accounts deal page has tabs (DA-15); each tab of the main fixture is checked too.
  'finance-deal-detail--money',
  'finance-deal-detail--review',
  'finance-deal-detail--receipts',
  'finance-deal-detail--documents',
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
  await page.waitForLoadState('networkidle');
}

test.describe('Phase 5A previews: accessibility and the disclaimer on desktop and 390 px', () => {
  for (const state of states) {
    test(`axe clean, one h1, disclaimer: ${state}`, async ({ page }) => {
      await open(page, state);
      expect(await axe(page)).toEqual([]);
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      await expect(page.getByRole('main').getByText(DISCLAIMER)).toBeVisible();
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
    await open(page, 'finance-deal-detail--money');
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
    for (const tab of ['receipts', 'documents'] as const) {
      await open(page, `finance-deal-detail--${tab}`);
      await expect(page.getByRole('main'), tab).not.toContainText('₹1,32,000.50');
    }
  });

  test('every receipt status label from the contract appears', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const list = page.getByRole('list', { name: 'Receipts, newest first' });
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
    await expect(list).toContainText('Internal receipt number');
  });

  test('blocked actions show the contract reason next to an unavailable button', async ({ page }) => {
    await open(page, 'finance-deal-blocked--receipts');
    let main = page.getByRole('main');
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
    const record = page.getByRole('region', { name: 'Record a receipt' });
    await expect(record).toContainText('No payment mode is available yet.');
    const modes = record.getByRole('group', { name: 'How did the customer pay?' });
    await expect(modes.getByText('Not available yet', { exact: true })).toHaveCount(4);
    const button = record.getByRole('button', { name: 'Record receipt' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription('This payment mode is not live yet.');
  });

  test('partly live: live modes record, others explain', async ({ page }) => {
    await open(page, 'finance-deal-partly-live--receipts');
    const record = page.getByRole('region', { name: 'Record a receipt' });
    await expect(record.getByRole('button', { name: 'Record bank transfer receipt' })).toBeVisible();
    await record.getByRole('radio', { name: /Cheque/ }).check();
    await expect(record.getByRole('button', { name: 'Record receipt' })).toHaveAttribute('aria-disabled', 'true');
    await record.getByRole('radio', { name: /UPI/ }).check();
    await expect(record.getByLabel('UPI transaction reference')).toBeVisible();
  });

  test('record form fields follow the mode; cash shows the policy caps', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = page.getByRole('region', { name: 'Record a receipt' });
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
    const record = page.getByRole('region', { name: 'Record a receipt' });
    await record.getByRole('radio', { name: /Cash/ }).check();
    await expect(record.getByText(/Cash is switched off by company policy/).first()).toBeVisible();
    await expect(record.getByRole('button', { name: 'Record receipt' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('a stub submit answers with an error and keeps typed values (no fake success)', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = page.getByRole('region', { name: 'Record a receipt' });
    await record.getByLabel('Amount received (₹)').fill('1234.50');
    await record.getByLabel('Payer name').fill('Synthetic Payer Z');
    await record.getByRole('button', { name: 'Record bank transfer receipt' }).click();
    await expect(record.getByRole('alert')).toContainText('Design preview: nothing is saved.');
    await expect(record.getByLabel('Amount received (₹)')).toHaveValue('1234.50');
    await expect(record.getByLabel('Payer name')).toHaveValue('Synthetic Payer Z');
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Done:' })).toHaveCount(0);
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
    await expect(page.getByRole('region', { name: 'Jodhpur' })).toContainText('Nothing unresolved at this branch.');
  });

  test('policy page: current, scheduled, history, read-only ceilings and edit form', async ({ page }) => {
    await open(page, 'finance-policy');
    await expect(page.getByRole('region', { name: 'Current policy' })).toContainText('Version 2 in force');
    await expect(page.getByRole('region', { name: 'Legal ceilings' })).toContainText('₹1,99,999.00');
    await expect(page.getByRole('region', { name: 'Legal ceilings' }).getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Scheduled policy versions' })).toContainText('Version 3 · scheduled');
    await expect(page.getByRole('list', { name: 'Policy versions, newest first' }).getByRole('listitem')).toHaveCount(2);
    const form = page.getByRole('form', { name: 'Schedule a new policy version' });
    await expect(form.getByLabel('Reason for the change')).toBeVisible();
    await expect(form.getByLabel('Takes effect at (IST)')).toBeVisible();
    await expect(form.getByLabel('Largest single receipt (₹)')).toHaveValue('10000000');
  });

  test('policy error state marks the exact fields', async ({ page }) => {
    await open(page, 'finance-policy-error');
    const form = page.getByRole('form', { name: 'Schedule a new policy version' });
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
  test('queue filters and lookup are reachable by keyboard with the current filter marked', async ({ page }) => {
    await open(page, 'finance-queue-lookup-found');
    const filters = page.getByRole('navigation', { name: 'To check tabs' });
    await expect(filters.getByRole('link', { name: /^Booking reviews/ })).toHaveAttribute('aria-current', 'page');
    const input = page.getByLabel('Deal reference');
    await input.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Find deal' })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'SYN-JDH-009' })).toBeVisible();
  });

  test('payment mode radios change with arrow keys and reveal the right fields', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
    const record = page.getByRole('region', { name: 'Record a receipt' });
    const bank = record.getByRole('radio', { name: /Bank transfer/ });
    await bank.focus();
    await page.keyboard.press('ArrowRight');
    await expect(record.getByRole('radio', { name: /UPI/ })).toBeChecked();
    await expect(record.getByLabel('UPI transaction reference')).toBeVisible();
  });

  test('a reject form opens from the keyboard and focuses into its fields', async ({ page }) => {
    await open(page, 'finance-deal-detail--receipts');
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
    const record = page.getByRole('region', { name: 'Record a receipt' });
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
    const record = page.getByRole('region', { name: 'Record a receipt' });
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
